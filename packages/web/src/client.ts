import { DurableQueue } from "./queue.js";
import { Transport, type SendResult } from "./transport.js";
import {
  clearIdentity,
  doNotTrackEnabled,
  getOrCreateAnonId,
  getUserId,
  isBrowser,
  makeStore,
  nowISO,
  pageContext,
  setUserId,
  uuid,
  type KVStore,
} from "./runtime.js";
import type {
  IdentifyParams,
  QueuedOp,
  TrackOp,
  WhisperrApi,
  WhisperrChannel,
  WhisperrError,
  WhisperrOptions,
} from "./types.js";

const OPTOUT_KEY = "whisperr.optout";
const DEFAULT_BASE = "https://api.whisperr.net";

export class WhisperrClient implements WhisperrApi {
  readonly ready: boolean;

  private readonly store: KVStore;
  private readonly queue: DurableQueue;
  private readonly transport: Transport;

  private readonly flushAt: number;
  private readonly maxBatchSize: number;
  private readonly maxRetries: number;
  private readonly debug: boolean;
  private readonly onError?: (error: WhisperrError) => void;

  private userId: string | null = null;
  private anonId = "";
  private muted: boolean; // opted out / disabled / DNT — capture is a no-op
  private drainChain: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WhisperrOptions) {
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.flushAt = options.flushAt ?? 20;
    this.maxBatchSize = Math.min(options.maxBatchSize ?? 500, 500);
    this.maxRetries = options.maxRetries ?? 6;
    this.debug = options.debug ?? false;
    this.onError = options.onError;

    this.store = makeStore(options.persistence ?? "localStorage");
    this.queue = new DurableQueue(this.store, options.maxQueueSize ?? 1000);
    this.transport = new Transport(baseUrl, options.apiKey, options.requestTimeoutMs ?? 10000, this.debug);

    const dntBlocked = (options.respectDoNotTrack ?? false) && doNotTrackEnabled();
    this.muted = !isBrowser || !!options.disabled || dntBlocked || this.isOptedOut();
    this.ready = isBrowser && !this.muted;

    if (!isBrowser) return;

    this.anonId = getOrCreateAnonId(this.store);
    this.userId = getUserId(this.store);

    if (!this.muted) {
      this.startTimers(options.flushIntervalMs ?? 10000);
      this.installLifecycle();
      if (options.autocapturePageviews ?? true) this.installPageviews();
      // Drain anything left from a previous page load.
      void this.flush();
    }
  }

  identify(externalUserId: string, params: IdentifyParams = {}): void {
    if (this.muted || !externalUserId) return;
    this.userId = externalUserId;
    setUserId(this.store, externalUserId);

    this.enqueue({
      kind: "identify",
      externalUserId,
      traits: params.traits,
      channels: buildChannels(params),
      occurredAt: nowISO(),
    });
    // Anonymous → identified: attribute buffered pre-login events to this user.
    this.queue.backfillIdentity(externalUserId);
    void this.flush();
  }

  track(eventType: string, properties?: Record<string, unknown>, context?: Record<string, unknown>): void {
    if (this.muted || !eventType) return;
    this.enqueue({
      kind: "track",
      eventType,
      externalUserId: this.userId, // null until identify(); backfilled later
      properties,
      context: { ...pageContext(this.store), ...context },
      occurredAt: nowISO(),
      messageId: uuid(),
    });
    if (this.sendableCount() >= this.flushAt) void this.flush();
  }

  page(name?: string, properties?: Record<string, unknown>): void {
    this.track("$pageview", { name, ...properties });
  }

  reset(): void {
    clearIdentity(this.store);
    this.userId = null;
    this.anonId = getOrCreateAnonId(this.store); // fresh anonymous identity
  }

  optIn(): void {
    this.store.remove(OPTOUT_KEY);
    this.muted = !isBrowser;
  }

  optOut(): void {
    this.store.set(OPTOUT_KEY, "1");
    this.muted = true;
    this.queue.clear();
  }

  async flush(): Promise<void> {
    if (this.muted) return;
    // Serialize drains and guarantee that awaiting flush() waits for a drain
    // pass that runs AFTER this call — so `await whisperr.flush()` before logout
    // actually delivers everything queued, even if a background flush is mid-send.
    const next = this.drainChain.then(() => this.lockedDrain()).catch(() => {});
    this.drainChain = next;
    await next;
  }

  private async lockedDrain(): Promise<void> {
    if (this.muted) return;
    // Cross-tab safety: only one tab drains the shared queue at a time. The Web
    // Locks API serializes across tabs; ifAvailable:true means we skip (rather
    // than wait) when another tab already holds the lock.
    const locks =
      (typeof navigator !== "undefined" &&
        (navigator as Navigator & { locks?: LockManager }).locks) ||
      null;
    if (locks && typeof locks.request === "function") {
      await locks.request("whisperr.flush", { ifAvailable: true }, async (lock) => {
        if (lock) await this.drain();
      });
    } else {
      await this.drain();
    }
  }

  private async drain(): Promise<void> {
    let retries = 0;
    while (this.queue.size > 0) {
      const ops = this.queue.all;
      const front = ops[0]!;
      if (front.kind === "track" && front.externalUserId === null) break; // buffered pre-identify

      let result: SendResult;
      let count: number;
      if (front.kind === "identify") {
        result = await this.transport.sendIdentify(front);
        count = 1;
      } else {
        const batch = this.takeTrackBatch(ops);
        result = await this.transport.sendBatch(batch);
        count = batch.length;
      }

      if (result === "ok") {
        this.queue.removeFront(count);
        retries = 0;
        continue;
      }
      if (result === "drop") {
        this.queue.removeFront(count);
        retries = 0;
        this.emit({ type: "dropped", message: `dropped ${count} event(s) — rejected by server` });
        continue;
      }
      if (result === "auth") {
        this.emit({ type: "auth", message: "delivery paused — API key rejected", status: 401 });
        break; // keep queue for a later attempt
      }
      // retry
      if (++retries > this.maxRetries) {
        this.emit({ type: "retry_exhausted", message: "delivery failed after retries; will retry on next flush" });
        break;
      }
      await delay(backoff(retries));
    }
  }

  private emit(error: WhisperrError): void {
    try {
      this.onError?.(error);
    } catch {
      /* host callback threw — ignore */
    }
  }

  // ---- internals ----

  private enqueue(op: QueuedOp): void {
    this.queue.enqueue(op);
  }

  private takeTrackBatch(ops: readonly QueuedOp[]): TrackOp[] {
    const batch: TrackOp[] = [];
    for (const op of ops) {
      if (op.kind === "track" && op.externalUserId) {
        batch.push(op);
        if (batch.length >= this.maxBatchSize) break;
      } else {
        break;
      }
    }
    return batch;
  }

  private sendableCount(): number {
    let n = 0;
    for (const op of this.queue.all) {
      if (op.kind === "track" && op.externalUserId === null) break;
      n++;
    }
    return n;
  }

  private isOptedOut(): boolean {
    return makeStore("localStorage").get(OPTOUT_KEY) === "1";
  }

  private startTimers(intervalMs: number): void {
    this.flushTimer = setInterval(() => void this.flush(), intervalMs);
    // Don't keep a Node-like process alive in edge runtimes.
    (this.flushTimer as unknown as { unref?: () => void }).unref?.();
  }

  private installLifecycle(): void {
    const onExit = () => this.flushOnExit();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") onExit();
    });
    window.addEventListener("pagehide", onExit);
  }

  /** Best-effort synchronous exit flush — keepalive keeps the request + auth
   *  alive through unload. Optimistically dequeue so we don't double-send next load. */
  private flushOnExit(): void {
    if (this.muted) return;
    const ops = this.queue.all;
    if (ops.length === 0) return;
    const front = ops[0]!;
    if (front.kind === "track" && front.externalUserId === null) return; // buffered

    // Optimistically dequeue so a next page load doesn't resend; the keepalive
    // request survives unload, and each event's $message_id lets the backend
    // dedup the rare case where it both delivers here and is retried elsewhere.
    if (front.kind === "identify") {
      void this.transport.sendIdentify(front, { keepalive: true });
      this.queue.removeFront(1);
    } else {
      const batch = this.takeTrackBatch(ops);
      void this.transport.sendBatch(batch, { keepalive: true });
      this.queue.removeFront(batch.length);
    }
  }

  private installPageviews(): void {
    const fire = () => this.page();
    const patch = (key: "pushState" | "replaceState") => {
      const orig = history[key];
      history[key] = function (this: History, ...args: Parameters<History["pushState"]>) {
        const ret = orig.apply(this, args);
        window.dispatchEvent(new Event("whisperr:locationchange"));
        return ret;
      };
    };
    patch("pushState");
    patch("replaceState");
    window.addEventListener("whisperr:locationchange", fire);
    window.addEventListener("popstate", fire);
    fire(); // initial pageview
  }
}

function buildChannels(params: IdentifyParams): WhisperrChannel[] | undefined {
  if (params.channels && params.channels.length) return params.channels;
  const out: WhisperrChannel[] = [];
  if (params.email) out.push({ type: "email", address: params.email, optedIn: true });
  if (params.phone) out.push({ type: "sms", address: params.phone, optedIn: true });
  if (params.pushToken) out.push({ type: "push", address: params.pushToken, optedIn: true });
  return out.length ? out : undefined;
}

function backoff(attempt: number): number {
  const base = Math.min(30000, 1000 * 2 ** attempt);
  return base + Math.floor(Math.random() * 250);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

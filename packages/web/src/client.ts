import { DurableQueue, opKey } from "./queue.js";
import { Transport, identifyBody, wireEvent, type SendOutcome } from "./transport.js";
import {
  clearIdentity,
  deviceTraits,
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
const SNAKE_CASE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

// Keepalive request bodies share a 64 KiB in-flight quota per page (Fetch
// spec); a request over it is rejected outright. Stay under it, leaving
// headroom for the host app's own keepalive/beacon traffic.
const KEEPALIVE_BUDGET = 60 * 1024;
const BATCH_ENVELOPE_BYTES = '{"events":[]}'.length;

// Page-wide exit-flush bookkeeping, shared by every client instance: the
// keepalive quota is per page, and instances sharing the persisted queue (or
// repeated hide events) must not put the same op in flight twice.
const exitInflight = { bytes: 0, keys: new Set<string>() };

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
      anonymousId: this.anonId,
      traits: withDeviceTraits(params.traits),
      preferredChannel: params.preferredChannel,
      channels: buildChannels(params),
      occurredAt: nowISO(),
    });
    // Pre-login events not yet sent go out under this user; the identify's
    // anonymous_id promotes the ones already sent.
    this.queue.backfillIdentity(externalUserId);
    void this.flush();
  }

  track(eventType: string, properties?: Record<string, unknown>, context?: Record<string, unknown>): void {
    if (this.muted || !eventType) return;
    const type = eventType.trim();
    if (!type) return;
    if (!SNAKE_CASE.test(type)) {
      this.emit({ type: "dropped", message: `invalid event_type "${type}" — expected snake_case` });
      if (this.debug) {
        // eslint-disable-next-line no-console
        console.warn(`[whisperr] invalid event_type "${type}" — event was not queued`);
      }
      return;
    }
    this.enqueue({
      kind: "track",
      eventType: type,
      externalUserId: this.userId, // null before identify(): sent under anonymousId
      anonymousId: this.anonId,
      properties,
      context: { ...pageContext(this.store), ...context },
      occurredAt: nowISO(),
      messageId: uuid(),
    });
    if (this.queue.size >= this.flushAt) void this.flush();
  }

  page(name?: string, properties?: Record<string, unknown>): void {
    // snake_case to satisfy the ingestion validator (it rejects "$"-prefixed types).
    this.track("page_viewed", { name, ...properties });
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

      let outcome: SendOutcome;
      let sent: QueuedOp[];
      if (front.kind === "identify") {
        outcome = await this.transport.sendIdentify(front);
        sent = [front];
      } else {
        const batch = this.takeTrackBatch(ops);
        outcome = await this.transport.sendBatch(batch);
        sent = batch;
      }

      const { result } = outcome;
      if (result === "ok") {
        this.queue.remove(sent);
        retries = 0;
        continue;
      }
      if (result === "drop") {
        this.queue.remove(sent);
        retries = 0;
        this.emit({ type: "dropped", message: `dropped ${sent.length} event(s) — rejected by server` });
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
      await delay(retryDelay(retries, outcome.retryAfterMs));
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
      if (op.kind !== "track") break;
      batch.push(this.withAnonymousId(op));
      if (batch.length >= this.maxBatchSize) break;
    }
    return batch;
  }

  /** Ops persisted by a pre-0.2 SDK have no anonymousId; they are this visitor's. */
  private withAnonymousId(op: TrackOp): TrackOp {
    return op.anonymousId ? op : { ...op, anonymousId: this.anonId };
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

  /**
   * Exit flush: the page is being hidden or unloaded, so the next timer tick
   * may never come. Sends everything that fits the keepalive quota right now —
   * keepalive requests outlive the page and, unlike sendBeacon, still carry the
   * X-API-Key header. Whatever doesn't fit stays queued for the next load.
   *
   * Delivery is at-least-once: ops stay persisted until a response confirms
   * them. If the page dies first, the next load resends them with the same
   * $message_id and the backend dedups (unique per app + message id); removing
   * them up front would instead lose them whenever the request fails.
   */
  private flushOnExit(): void {
    if (this.muted) return;
    let free = KEEPALIVE_BUDGET - exitInflight.bytes;
    const batch: TrackOp[] = [];
    const parts: string[] = [];
    let batchBytes = BATCH_ENVELOPE_BYTES;
    const sendBatch = () => {
      if (!batch.length) return;
      this.sendOnExit("/v1/events/batch", `{"events":[${parts.join(",")}]}`, batchBytes, batch.splice(0));
      free -= batchBytes;
      parts.length = 0;
      batchBytes = BATCH_ENVELOPE_BYTES;
    };

    for (const op of this.queue.all) {
      if (exitInflight.keys.has(opKey(op))) continue; // already on its way
      if (op.kind === "identify") {
        const body = JSON.stringify(identifyBody(op));
        const bytes = utf8Length(body);
        if (bytes <= free - (batch.length ? batchBytes : 0)) {
          this.sendOnExit("/v1/identify", body, bytes, [op]);
          free -= bytes;
        }
        continue;
      }
      if (batch.length >= this.maxBatchSize) sendBatch();
      const part = JSON.stringify(wireEvent(this.withAnonymousId(op)));
      const bytes = utf8Length(part) + (parts.length ? 1 : 0); // + separating comma
      if (batchBytes + bytes > free) continue; // over the quota — left for the next load
      batch.push(op);
      parts.push(part);
      batchBytes += bytes;
    }
    sendBatch();
  }

  private sendOnExit(path: string, json: string, bytes: number, ops: QueuedOp[]): void {
    const keys = ops.map(opKey);
    for (const k of keys) exitInflight.keys.add(k);
    exitInflight.bytes += bytes;
    void this.transport
      .sendRaw(path, json, { keepalive: true })
      .then(({ result }) => {
        // Still alive to see the response (tab hidden, or it beat the unload):
        // settle it exactly like a normal drain would.
        if (result === "ok" || result === "drop") this.queue.remove(ops);
        if (result === "drop") {
          this.emit({ type: "dropped", message: `dropped ${ops.length} event(s) — rejected by server` });
        }
      })
      .catch(() => {})
      .finally(() => {
        exitInflight.bytes -= bytes;
        for (const k of keys) exitInflight.keys.delete(k);
      });
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

/** Keys the engine reads for the user's zone; any of them supplied means "don't default `timezone`". */
const TIMEZONE_KEYS = ["timezone", "time_zone", "tz"];

/**
 * Fills the reserved `timezone` / `locale` traits from the browser unless the
 * caller supplied them — caller values always win, and a key the environment
 * cannot provide is simply absent (see whisperr-spec → Reserved trait keys).
 */
function withDeviceTraits(traits: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const defaults: Record<string, unknown> = deviceTraits();
  if (traits && TIMEZONE_KEYS.some((k) => k in traits)) delete defaults.timezone;
  const merged = { ...defaults, ...traits };
  return Object.keys(merged).length ? merged : undefined;
}

function buildChannels(params: IdentifyParams): WhisperrChannel[] | undefined {
  if (params.channels && params.channels.length) return params.channels;
  const out: WhisperrChannel[] = [];
  if (params.email) out.push({ type: "email", address: params.email, optedIn: true });
  if (params.phone) out.push({ type: "sms", address: params.phone, optedIn: true });
  if (params.pushToken) out.push({ type: "push", address: params.pushToken, optedIn: true });
  return out.length ? out : undefined;
}

/** A server-sent Retry-After (already capped) wins over exponential backoff; both get jitter. */
function retryDelay(attempt: number, retryAfterMs?: number): number {
  const base = retryAfterMs ?? Math.min(30000, 1000 * 2 ** attempt);
  return base + Math.floor(Math.random() * 250);
}

/** UTF-8 byte length of a string — what the keepalive quota counts. */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4; // surrogate pair → one 4-byte code point
      i++;
    } else n += 3;
  }
  return n;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

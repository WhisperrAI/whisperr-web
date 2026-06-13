import type { IdentifyOp, TrackOp } from "./types.js";

export type SendResult = "ok" | "retry" | "auth" | "drop";

export interface SendOptions {
  /** Use keepalive so the request survives page unload (still sends headers). */
  keepalive?: boolean;
}

/**
 * Network transport for the ingestion API. Uses `fetch` with `keepalive` for
 * unload flushes — unlike navigator.sendBeacon, keepalive requests can still set
 * the X-API-Key header, so we keep auth on the churn-critical exit events.
 */
export class Transport {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number,
    private readonly debug: boolean,
  ) {}

  async sendBatch(events: TrackOp[], opts: SendOptions = {}): Promise<SendResult> {
    const body = {
      events: events
        .filter((e) => e.externalUserId)
        .map((e) => ({
          external_user_id: e.externalUserId,
          event_type: e.eventType,
          occurred_at: e.occurredAt,
          properties: e.properties ?? {},
          // $message_id is an idempotency key for backend dedup (nested in the
          // free-form context so the strict ingestion accepts it).
          context: { ...(e.context ?? {}), $message_id: e.messageId },
        })),
    };
    if (body.events.length === 0) return "ok";
    return this.post("/v1/events/batch", body, opts);
  }

  async sendIdentify(op: IdentifyOp, opts: SendOptions = {}): Promise<SendResult> {
    const body: Record<string, unknown> = {
      external_user_id: op.externalUserId,
    };
    if (op.traits && Object.keys(op.traits).length) body.traits = op.traits;
    if (op.channels && op.channels.length) {
      body.channels = op.channels.map((c) => ({
        // wire field is `channel` (the server rejects unknown fields)
        channel: c.type,
        address: c.address,
        opted_in: c.optedIn ?? true,
      }));
    }
    return this.post("/v1/identify", body, opts);
  }

  private async post(path: string, body: unknown, opts: SendOptions): Promise<SendResult> {
    const url = `${this.baseUrl}${path}`;
    const controller = !opts.keepalive ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), this.timeoutMs)
      : null;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
        },
        body: JSON.stringify(body),
        keepalive: opts.keepalive ?? false,
        signal: controller?.signal,
      });
      if (res.ok) return "ok";
      if (res.status === 401 || res.status === 403) {
        this.warn(`auth rejected (${res.status}) — check your Whisperr API key`);
        return "auth";
      }
      if (res.status === 429 || res.status >= 500) return "retry";
      // Other 4xx — malformed; dropping avoids an infinite retry loop.
      this.warn(`request to ${path} dropped (${res.status})`);
      return "drop";
    } catch {
      // Network error / timeout / abort — retry later.
      return "retry";
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private warn(msg: string): void {
    if (this.debug && typeof console !== "undefined") {
      // eslint-disable-next-line no-console
      console.warn(`[whisperr] ${msg}`);
    }
  }
}

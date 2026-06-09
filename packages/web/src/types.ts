/** Public types for the Whisperr web SDK. */

export interface WhisperrChannel {
  /** "email" | "sms" | "push" | custom. */
  type: string;
  /** The address/token for the channel (email address, phone, push token). */
  address: string;
  /** Whether the user has opted in to this channel. */
  optedIn?: boolean;
}

export interface IdentifyParams {
  /** Arbitrary traits (plan, signup_date, …). Merged server-side. */
  traits?: Record<string, unknown>;
  /** Convenience: expands to an opted-in email channel. */
  email?: string;
  /** Convenience: expands to an opted-in SMS channel. */
  phone?: string;
  /** Convenience: expands to an opted-in push channel. */
  pushToken?: string;
  /** Full control over channels (overrides the shortcuts when provided). */
  channels?: WhisperrChannel[];
}

export interface WhisperrOptions {
  /** App ingestion key (wrk_…). Required. */
  apiKey: string;
  /** Ingestion base URL. Defaults to https://api.whisperr.net. */
  baseUrl?: string;
  /** Flush when this many events are queued. Default 20. */
  flushAt?: number;
  /** Flush at least this often (ms). Default 10000. */
  flushIntervalMs?: number;
  /** Max events held in the durable queue; oldest drop on overflow. Default 1000. */
  maxQueueSize?: number;
  /** Max events per batch request (hard backend cap is 500). Default 500. */
  maxBatchSize?: number;
  /** Auto-capture SPA pageviews ($pageview). Default true. */
  autocapturePageviews?: boolean;
  /** Honor the browser's Do Not Track signal. Default false. */
  respectDoNotTrack?: boolean;
  /** Where to persist the queue + ids. Default "localStorage". */
  persistence?: "localStorage" | "memory";
  /** Disable all network + capture (no-op client). Default false. */
  disabled?: boolean;
  /** Verbose logging to the console. Default false. */
  debug?: boolean;
  /** Per-request timeout (ms). Default 10000. */
  requestTimeoutMs?: number;
  /** Max consecutive retries before backing off a drain. Default 6. */
  maxRetries?: number;
  /** Called when delivery fails (auth/drop/retries exhausted). For observability. */
  onError?: (error: WhisperrError) => void;
}

export interface WhisperrError {
  type: "auth" | "dropped" | "retry_exhausted";
  message: string;
  status?: number;
}

/** The public client surface. */
export interface WhisperrApi {
  identify(externalUserId: string, params?: IdentifyParams): void;
  track(eventType: string, properties?: Record<string, unknown>, context?: Record<string, unknown>): void;
  page(name?: string, properties?: Record<string, unknown>): void;
  flush(): Promise<void>;
  reset(): void;
  optIn(): void;
  optOut(): void;
  /** True once init() has run in a browser. */
  readonly ready: boolean;
}

// ---- internal wire/queue shapes ----

export interface IdentifyOp {
  kind: "identify";
  externalUserId: string;
  traits?: Record<string, unknown>;
  channels?: WhisperrChannel[];
  occurredAt: string;
}

export interface TrackOp {
  kind: "track";
  eventType: string;
  /** null until the user is identified; filled in on identify(), then sent. */
  externalUserId: string | null;
  properties?: Record<string, unknown>;
  context?: Record<string, unknown>;
  occurredAt: string;
  /** Idempotency key — lets the backend dedup retries / exit-flush resends. */
  messageId: string;
}

export type QueuedOp = IdentifyOp | TrackOp;

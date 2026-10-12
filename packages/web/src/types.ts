/** Public types for the Whisperr web SDK. */

export interface WhisperrChannel {
  /** "email" | "sms" | "push" | custom. */
  type: string;
  /** The address/token for the channel (email address, phone, push token). */
  address: string;
  /** Whether the user has opted in to this channel. */
  optedIn?: boolean;
  /** Whether the address is verified. */
  verified?: boolean;
}

export interface IdentifyParams {
  /**
   * Arbitrary traits (plan, signup_date, …). Merged server-side. The reserved
   * keys `timezone` (IANA name) and `locale` (BCP 47) are filled in from the
   * browser unless you supply them — your values always win.
   */
  traits?: Record<string, unknown>;
  /** Convenience: expands to an opted-in email channel. */
  email?: string;
  /** Convenience: expands to an opted-in SMS channel. */
  phone?: string;
  /** Convenience: expands to an opted-in push channel. */
  pushToken?: string;
  /** Preferred outreach channel. */
  preferredChannel?: "email" | "sms" | "push";
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
  /** Auto-capture SPA pageviews (page_viewed). Default true. */
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
  /**
   * Your app's release version (for example "2.4.0"). Sent as
   * `context.app_version` on every event. Omitted when not set.
   */
  appVersion?: string;
  /** Your app's build number or id (for example "512"). Sent as `context.app_build`. Omitted when not set. */
  appBuild?: string;
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
  /**
   * Sets the language the user picked in your product (BCP 47, for example
   * "de" or "pt-BR"; "_" is changed to "-"). It is not the browser locale.
   * The value is persisted and sent as `traits.app_language` with every
   * identify. `null` clears the stored value (the server keeps the last value).
   */
  setAppLanguage(tag: string | null): void;
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
  /** null for an anonymous identify (traits for the anonymous handle only). */
  externalUserId: string | null;
  /**
   * The anonymous handle this device used before identify(); the server
   * promotes it into the user. Absent on a partial identify.
   */
  anonymousId?: string;
  traits?: Record<string, unknown>;
  preferredChannel?: string;
  channels?: WhisperrChannel[];
  occurredAt: string;
  /** Local queue identity only (never sent). Absent on ops queued by SDK <= 0.2. */
  messageId?: string;
  /** Local only: the identify the SDK queues at start for a stored user. */
  restore?: boolean;
  /** Local only: a traits-only update (setAppLanguage); it updates the receipt traits, not its time. */
  partial?: boolean;
}

export interface TrackOp {
  kind: "track";
  eventType: string;
  /** null until the user is identified; a null-user event goes out under anonymousId. */
  externalUserId: string | null;
  /** The device's anonymous handle; on the wire only when there is no user id. */
  anonymousId: string;
  properties?: Record<string, unknown>;
  context?: Record<string, unknown>;
  occurredAt: string;
  /** Idempotency key — lets the backend dedup retries / exit-flush resends. */
  messageId: string;
}

export type QueuedOp = IdentifyOp | TrackOp;

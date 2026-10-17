/** Browser/runtime primitives — all SSR-safe (no throw when window is absent). */

export const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

export const SDK_NAME = "whisperr-web";
export const SDK_VERSION = "0.5.0";

export function doNotTrackEnabled(): boolean {
  if (!isBrowser) return false;
  const nav = navigator as Navigator & { doNotTrack?: string; msDoNotTrack?: string };
  const dnt = nav.doNotTrack ?? (window as unknown as { doNotTrack?: string }).doNotTrack ?? nav.msDoNotTrack;
  return dnt === "1" || dnt === "yes";
}

let idCounter = 0;

/**
 * UUID v4 from the Web Crypto RNG. `getRandomValues` exists in every browser
 * this SDK targets (ES2020), on http origins too, where `randomUUID` does not.
 */
export function uuid(): string {
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    // No Web Crypto (not a supported browser): unique per runtime, not random.
    const t = Date.now().toString(16).padStart(12, "0").slice(-12);
    const n = (++idCounter).toString(16).padStart(19, "0").slice(-19);
    return `${n.slice(0, 8)}-${n.slice(8, 12)}-4${n.slice(12, 15)}-8${n.slice(15, 18)}-${n.slice(18)}${t.slice(1)}`;
  }
  if (typeof crypto.randomUUID === "function" && (typeof isSecureContext === "undefined" || isSecureContext)) {
    return crypto.randomUUID();
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function nowISO(): string {
  return new Date().toISOString();
}

// ---- storage: localStorage with an in-memory fallback (private mode / SSR) ----

export interface KVStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

class MemoryStore implements KVStore {
  private m = new Map<string, string>();
  get(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  set(k: string, v: string) {
    this.m.set(k, v);
  }
  remove(k: string) {
    this.m.delete(k);
  }
}

class LocalStore implements KVStore {
  get(k: string) {
    try {
      return window.localStorage.getItem(k);
    } catch {
      return null;
    }
  }
  set(k: string, v: string) {
    try {
      window.localStorage.setItem(k, v);
    } catch {
      /* quota / disabled — drop silently */
    }
  }
  remove(k: string) {
    try {
      window.localStorage.removeItem(k);
    } catch {
      /* noop */
    }
  }
}

export function makeStore(pref: "localStorage" | "memory"): KVStore {
  if (pref === "memory" || !isBrowser) return new MemoryStore();
  // Verify localStorage is actually usable (Safari private mode throws).
  try {
    const probe = "__wsp_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return new LocalStore();
  } catch {
    return new MemoryStore();
  }
}

// ---- identity + session ----

const ANON_KEY = "whisperr.anon_id";
const USER_KEY = "whisperr.user_id";
const SESSION_KEY = "whisperr.session";
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export function getOrCreateAnonId(store: KVStore): string {
  let id = store.get(ANON_KEY);
  if (!id) {
    id = uuid(); // sent as anonymous_id — the spec pins a UUID v4
    store.set(ANON_KEY, id);
  }
  return id;
}

export function setUserId(store: KVStore, id: string): void {
  store.set(USER_KEY, id);
}
export function getUserId(store: KVStore): string | null {
  return store.get(USER_KEY);
}
export function clearIdentity(store: KVStore): void {
  store.remove(USER_KEY);
  store.remove(ANON_KEY);
}

/** The stored session id, expired or not, without marking activity. */
export function storedSessionId(store: KVStore): string | null {
  try {
    const s = JSON.parse(store.get(SESSION_KEY) ?? "null") as { id?: unknown } | null;
    return typeof s?.id === "string" ? s.id : null;
  } catch {
    return null;
  }
}

/** Returns the current session id, rolling it over after inactivity. */
export function currentSessionId(store: KVStore): string {
  return touchSession(store).id;
}

/**
 * Marks activity on the session and returns its id; `isNew` is true when this
 * call started the session (first event, or 30 min without one). The session
 * is shared by every tab of the origin through the store.
 */
export function touchSession(store: KVStore): { id: string; isNew: boolean } {
  const raw = store.get(SESSION_KEY);
  const now = Date.now();
  if (raw) {
    try {
      const s = JSON.parse(raw) as { id: string; last: number };
      if (now - s.last < SESSION_TIMEOUT_MS) {
        store.set(SESSION_KEY, JSON.stringify({ id: s.id, last: now }));
        return { id: s.id, isNew: false };
      }
    } catch {
      /* fall through to new session */
    }
  }
  const id = `sess_${uuid()}`;
  store.set(SESSION_KEY, JSON.stringify({ id, last: now }));
  return { id, isNew: true };
}

/**
 * Lightweight, non-PII page + library context attached to every event. It
 * never carries `locale`: the server reads `context.locale` as the message
 * language of that one event, so only the caller may set it.
 */
export function pageContext(store: KVStore, sessionId?: string): Record<string, unknown> {
  const ctx: Record<string, unknown> = {
    library: { name: SDK_NAME, version: SDK_VERSION },
    session_id: sessionId ?? currentSessionId(store),
  };
  if (isBrowser) {
    ctx.page = {
      url: location.href,
      path: location.pathname,
      referrer: document.referrer || undefined,
      title: document.title || undefined,
    };
    ctx.user_agent = navigator.userAgent;
  }
  return ctx;
}

/**
 * The version keys every client event carries in `context` (whisperr-spec →
 * versions on every event): platform, SDK name + version, and the app's
 * version / build when the app configured them. No value, no key.
 */
export function environmentContext(app: { appVersion?: string; appBuild?: string }): Record<string, string> {
  const ctx: Record<string, string> = { platform: "web", sdk_name: SDK_NAME, sdk_version: SDK_VERSION };
  const version = nonEmpty(app.appVersion);
  if (version) ctx.app_version = version;
  const build = nonEmpty(app.appBuild);
  if (build) ctx.app_build = build;
  return ctx;
}

function nonEmpty(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

// ---- app language (reserved trait `app_language`) ----

const APP_LANGUAGE_KEY = "whisperr.app_language";
// BCP 47 shape: a 2–3 letter (or 4–8 letter registered) primary subtag, then
// 1–8 character alphanumeric subtags. Well-formedness only; no registry lookup.
const BCP47 = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i;

/** BCP 47 tag with "_" changed to "-", or undefined when the value is not a well-formed tag. */
export function normalizeLanguageTag(tag: unknown): string | undefined {
  if (typeof tag !== "string") return undefined;
  const t = tag.trim().replace(/_/g, "-");
  return t.length <= 35 && BCP47.test(t) ? t : undefined;
}

export function getAppLanguage(store: KVStore): string | undefined {
  return normalizeLanguageTag(store.get(APP_LANGUAGE_KEY));
}
export function storeAppLanguage(store: KVStore, tag: string | null): void {
  if (tag === null) store.remove(APP_LANGUAGE_KEY);
  else store.set(APP_LANGUAGE_KEY, tag);
}

// ---- identify receipt (24h restore-identify throttle) ----

const RECEIPT_KEY = "whisperr.identify_receipt";

/** The traits a restore identify carries: device defaults and the app language. */
export const RESTORE_TRAIT_KEYS = ["timezone", "locale", "app_language"] as const;

/** What the server last confirmed for a user: its restore traits, and when. */
export interface IdentifyReceipt {
  user: string;
  traits: Record<string, unknown>;
  at: number;
}

export function getIdentifyReceipt(store: KVStore): IdentifyReceipt | null {
  const raw = store.get(RECEIPT_KEY);
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as IdentifyReceipt;
    const ok = typeof r?.user === "string" && typeof r.at === "number" && !!r.traits && typeof r.traits === "object";
    return ok ? r : null;
  } catch {
    return null;
  }
}
export function setIdentifyReceipt(store: KVStore, receipt: IdentifyReceipt): void {
  store.set(RECEIPT_KEY, JSON.stringify(receipt));
}
export function clearIdentifyReceipt(store: KVStore): void {
  store.remove(RECEIPT_KEY);
}

/** The restore-trait subset of an identify's traits. */
export function restoreTraitsOf(traits: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of RESTORE_TRAIT_KEYS) if (traits && traits[k] !== undefined) out[k] = traits[k];
  return out;
}

/** Order-independent equality of two trait objects. */
export function sameTraits(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  return canonicalJSON(a ?? {}) === canonicalJSON(b ?? {});
}

function canonicalJSON(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJSON).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.keys(v as Record<string, unknown>)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJSON((v as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

// ---- device traits (reserved identify trait keys) ----

/**
 * Environment-derived defaults for the reserved identify trait keys
 * (whisperr-spec SPEC.md → "Reserved trait keys"): `timezone` (IANA name, from
 * Intl) and `locale` (BCP 47, from navigator.language). The engine evaluates
 * quiet hours / send timing in `timezone` and picks the message language from
 * `locale`. Only keys the browser can actually provide are returned — never a
 * guess — and outside a browser (SSR) this is always `{}`.
 */
export function deviceTraits(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isBrowser) return out;
  const timezone = resolvedTimeZone();
  if (timezone) out.timezone = timezone;
  const locale = browserLocale();
  if (locale) out.locale = locale;
  return out;
}

function resolvedTimeZone(): string | undefined {
  try {
    if (typeof Intl === "undefined" || typeof Intl.DateTimeFormat !== "function") return undefined;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && tz.length > 0 ? tz : undefined;
  } catch {
    return undefined; // no tz data / exotic runtime — omit rather than guess
  }
}

function browserLocale(): string | undefined {
  try {
    const lang = (navigator as Navigator & { language?: string }).language;
    return typeof lang === "string" && lang.length > 0 ? lang : undefined;
  } catch {
    return undefined;
  }
}

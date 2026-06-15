/** Browser/runtime primitives — all SSR-safe (no throw when window is absent). */

export const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";

const LIB_VERSION = "0.1.6";

export function doNotTrackEnabled(): boolean {
  if (!isBrowser) return false;
  const nav = navigator as Navigator & { doNotTrack?: string; msDoNotTrack?: string };
  const dnt = nav.doNotTrack ?? (window as unknown as { doNotTrack?: string }).doNotTrack ?? nav.msDoNotTrack;
  return dnt === "1" || dnt === "yes";
}

/** RFC4122-ish v4 id; uses crypto when available, falls back gracefully. */
export function uuid(): string {
  if (isBrowser && typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback (non-crypto): fine for a client anonymous id.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
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
    id = `anon_${uuid()}`;
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

/** Returns the current session id, rolling it over after inactivity. */
export function currentSessionId(store: KVStore): string {
  const raw = store.get(SESSION_KEY);
  const now = Date.now();
  if (raw) {
    try {
      const s = JSON.parse(raw) as { id: string; last: number };
      if (now - s.last < SESSION_TIMEOUT_MS) {
        store.set(SESSION_KEY, JSON.stringify({ id: s.id, last: now }));
        return s.id;
      }
    } catch {
      /* fall through to new session */
    }
  }
  const id = `sess_${uuid()}`;
  store.set(SESSION_KEY, JSON.stringify({ id, last: now }));
  return id;
}

/** Lightweight, non-PII page + library context attached to every event. */
export function pageContext(store: KVStore): Record<string, unknown> {
  const ctx: Record<string, unknown> = {
    library: { name: "whisperr-web", version: LIB_VERSION },
    session_id: currentSessionId(store),
  };
  if (isBrowser) {
    ctx.page = {
      url: location.href,
      path: location.pathname,
      referrer: document.referrer || undefined,
      title: document.title || undefined,
    };
    ctx.locale = navigator.language;
    ctx.user_agent = navigator.userAgent;
  }
  return ctx;
}

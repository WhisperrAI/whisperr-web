// Engagement signals v3 helpers (whisperr-spec SPEC.md → "Engagement signals (v3)").
// Pure functions only: no window/document access, so they are SSR-safe.

export type ErrorKind = "js" | "dart" | "native" | "handled" | "network" | "screen";
export const ERROR_KINDS: readonly ErrorKind[] = ["js", "dart", "native", "handled", "network", "screen"];

/** Events the SDK sends itself; a customer track() of these names never counts in `event_count`. */
export const AUTOMATIC_EVENTS = new Set(["app_opened", "app_backgrounded", "app_error", "app_crashed", "page_viewed"]);

export const MAX_ERRORS_PER_SESSION = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path only; each segment that is all digits, a UUID, or 16+ characters becomes `:id`. ≤256 chars. */
export function redactRoute(pathname: string): string {
  const path = pathname.split(/[?#]/, 1)[0] || "/";
  const out = path
    .split("/")
    .map((seg) => (seg && (/^\d+$/.test(seg) || UUID.test(seg) || seg.length >= 16) ? ":id" : seg))
    .join("/");
  return (out.startsWith("/") ? out : `/${out}`).slice(0, 256);
}

/** `app_opened` attribution properties for a web landing URL. */
export function landingProperties(href: string): Record<string, string> {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { launch_source: "direct" };
  }
  const q = url.searchParams;
  const props: Record<string, string> = { launch_source: "direct" };
  const wmid = q.get("wmid")?.trim();
  const wsrc = q.get("wsrc");
  if (wmid) {
    props.launch_source = "email";
    props.whisperr_message_id = wmid.slice(0, 128);
  } else if (wsrc === "widget" || wsrc === "shortcut") {
    props.launch_source = wsrc;
  }
  if (url.protocol === "http:" || url.protocol === "https:") props.link_host = url.hostname;
  props.link_route = redactRoute(url.pathname);
  for (const k of ["utm_source", "utm_medium", "utm_campaign"]) {
    const v = q.get(k)?.trim();
    if (v) props[k] = v.slice(0, 128);
  }
  return props;
}

/** The error's class name, never its message. ≤64 chars. */
export function errorName(error: unknown, fallback = "Error"): string {
  let name: unknown;
  if (error && typeof error === "object") {
    name = (error as { name?: unknown }).name;
    if (typeof name !== "string" || !name.trim()) name = (error as object).constructor?.name;
  }
  const s = typeof name === "string" ? name.trim() : "";
  return (s && s !== "Object" ? s : fallback).slice(0, 64);
}

/**
 * Top stack frame function names (V8 `at fn (…)`, SpiderMonkey/JSC `fn@…`),
 * without paths, line or column numbers. Anonymous frames are skipped.
 */
export function stackFunctionNames(stack: unknown, max = 3): string[] {
  if (typeof stack !== "string") return [];
  const names: string[] = [];
  for (const raw of stack.split("\n")) {
    const line = raw.trim();
    let fn: string | undefined;
    const v8 = /^at (?:async )?(?:new )?([^\s(]+) \(/.exec(line);
    if (v8) fn = v8[1];
    else if (!line.startsWith("at ")) {
      const at = line.indexOf("@");
      if (at > 0) fn = line.slice(0, at).replace(/^async\*/, "");
    }
    if (fn && fn !== "<anonymous>") names.push(fn);
    if (names.length >= max) break;
  }
  return names;
}

/** First 16 hex chars of SHA-256(`error_name` + top-3 frame names, joined by "\n"). */
export function errorFingerprint(name: string, frames: readonly string[]): string {
  return sha256Hex([name, ...frames.slice(0, 3)].join("\n")).slice(0, 16);
}

// ---- SHA-256 (sync, so dedupe and ordering stay synchronous; works on http origins without Web Crypto) ----

// Round constants and initial hash: fractional parts of the cube / square roots of the first primes.
const PRIMES: number[] = [];
for (let n = 2; PRIMES.length < 64; n++) if (PRIMES.every((p) => n % p)) PRIMES.push(n);
const frac = (x: number) => ((x - Math.floor(x)) * 0x100000000) >>> 0;
const K = Uint32Array.from(PRIMES, (p) => frac(Math.cbrt(p)));
const H0 = Uint32Array.from(PRIMES.slice(0, 8), (p) => frac(Math.sqrt(p)));

export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const len = bytes.length;
  const total = (((len + 8) >> 6) + 1) << 6;
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[len] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(total - 8, Math.floor(len / 0x20000000));
  view.setUint32(total - 4, (len << 3) >>> 0);
  const h = H0.slice();
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh! + (rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)) + ((e! & f!) ^ (~e! & g!)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)) + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d! + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const out = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = h[i]! + out[i]!;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

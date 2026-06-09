import { Whisperr } from "./index.js";
import type { WhisperrApi, WhisperrOptions } from "./types.js";

/**
 * Entry for the hosted <script> build (whisperr.js). Pairs with the inline
 * method-queue stub: the stub makes window.whisperr.track(...) work before this
 * file loads by buffering calls; once loaded, we init the real client and
 * replay the buffered calls.
 *
 * Stub shape (set inline on the page):
 *   window.whisperr = []  // with ._key, ._opts, and pushed [method, ...args]
 */
interface Stub extends Array<[string, ...unknown[]]> {
  _key?: string;
  _opts?: Partial<WhisperrOptions>;
}

(function bootstrap() {
  if (typeof window === "undefined") return;
  const w = window as unknown as { whisperr?: Stub | WhisperrApi };
  const stub = w.whisperr;

  // Already a real client (double-load) — nothing to do.
  if (!stub || !Array.isArray(stub)) return;

  const apiKey = stub._key;
  if (!apiKey) {
    if (typeof console !== "undefined") {
      // eslint-disable-next-line no-console
      console.warn("[whisperr] script loaded but no api key — call whisperr.load('wrk_…')");
    }
    return;
  }

  const client = Whisperr.init({ apiKey, ...(stub._opts ?? {}) });

  // Replay buffered calls in order.
  for (const entry of stub) {
    const [method, ...args] = entry;
    const fn = (client as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
    if (typeof fn === "function") {
      try {
        fn.apply(client, args);
      } catch {
        /* ignore a bad buffered call */
      }
    }
  }
})();

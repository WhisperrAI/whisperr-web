import { WhisperrClient } from "./client.js";
import type { WhisperrApi, WhisperrOptions } from "./types.js";

export * from "./types.js";
export { WhisperrClient };

let singleton: WhisperrClient | null = null;

/**
 * Whisperr.init() creates the singleton client (idempotent) and exposes it as
 * `window.whisperr`. Safe to call during SSR — returns a no-op client there.
 */
export const Whisperr = {
  init(options: WhisperrOptions): WhisperrApi {
    if (!singleton) {
      singleton = new WhisperrClient(options);
      if (typeof window !== "undefined") {
        (window as unknown as { whisperr?: WhisperrApi }).whisperr = singleton;
      }
    }
    return singleton;
  },
  /** The current client, or null if init() hasn't run. */
  get instance(): WhisperrApi | null {
    return singleton;
  },
};

export default Whisperr;

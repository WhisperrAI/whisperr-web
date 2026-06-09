import { createContext, createElement, useContext, useRef, type ReactNode } from "react";
import { Whisperr, type WhisperrApi, type WhisperrOptions } from "@whisperr/web";

const WhisperrContext = createContext<WhisperrApi | null>(null);

export interface WhisperrProviderProps {
  /** Full options, or just pass `apiKey` for the simple case. */
  options?: WhisperrOptions;
  apiKey?: string;
  children: ReactNode;
}

/**
 * Initializes Whisperr once and makes the client available via useWhisperr().
 * Whisperr.init is idempotent, so this is safe under React StrictMode's
 * double-render and during SSR (returns a no-op client on the server).
 */
export function WhisperrProvider({ options, apiKey, children }: WhisperrProviderProps): JSX.Element {
  const ref = useRef<WhisperrApi | null>(null);
  if (ref.current === null) {
    const opts = options ?? (apiKey ? { apiKey } : undefined);
    if (!opts) {
      throw new Error("WhisperrProvider requires `apiKey` or `options`.");
    }
    ref.current = Whisperr.init(opts);
  }
  return createElement(WhisperrContext.Provider, { value: ref.current }, children);
}

/** Access the Whisperr client. Throws if used outside <WhisperrProvider>. */
export function useWhisperr(): WhisperrApi {
  const client = useContext(WhisperrContext);
  if (!client) {
    throw new Error("useWhisperr must be used within a <WhisperrProvider>.");
  }
  return client;
}

export type { WhisperrApi, WhisperrOptions } from "@whisperr/web";

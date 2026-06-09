"use client";

// A client-boundary re-export so Next.js App Router users can drop
// <WhisperrProvider apiKey="..."> straight into a server-component root layout.
// The Whisperr core auto-captures pageviews via the History API, which covers
// Next's client-side navigation.
export { WhisperrProvider, useWhisperr } from "@whisperr/react";
export type { WhisperrProviderProps } from "@whisperr/react";
export type { WhisperrApi, WhisperrOptions } from "@whisperr/web";

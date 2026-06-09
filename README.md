# whisperr-web

The Whisperr web SDKs — a tiny, framework-agnostic core plus thin React/Next adapters.

| Package | What it is |
|---|---|
| [`@whisperr/web`](packages/web) | Framework-agnostic core (~3KB gz). Works in any JS app. |
| [`@whisperr/react`](packages/react) | `<WhisperrProvider>` + `useWhisperr()`. |
| [`@whisperr/next`](packages/next) | App Router client-boundary provider. |

## Design

- **One core, thin adapters.** All logic lives in `@whisperr/web`; the framework packages are ergonomic wrappers (no duplicated logic).
- **Reliable by default.** Durable localStorage queue, `keepalive` flush on page hide (so churn-critical exit events aren't lost), batching, retry/backoff, 429/401 handling.
- **Anonymous → identified.** Pre-login events buffer and attribute to the user on `identify()`.
- **Respectful.** Cookieless, consent gate, DNT support, SSR-safe, tree-shakeable, zero deps.

## Develop

```bash
npm install          # workspaces
npm run build        # builds all packages (web first)
npm run typecheck
```

Publishing is automated: push a `vX.Y.Z` tag and CI publishes all three packages (requires the `NPM_TOKEN` repo secret).

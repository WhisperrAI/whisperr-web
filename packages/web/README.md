# @whisperr/web

Tiny, reliable event tracking for Whisperr — works in any JavaScript app.

```bash
npm i @whisperr/web
```

```ts
import { Whisperr } from "@whisperr/web";

const whisperr = Whisperr.init({ apiKey: "wrk_…" });

// after the user logs in / on session restore
whisperr.identify("user_123", { email: "ada@acme.com", traits: { plan: "pro" } });

// when something happens
whisperr.track("subscription_cancelled", { reason: "too_expensive" });

// on logout
whisperr.reset();
```

- **~3KB gzipped, zero dependencies.** Off the critical path.
- **Never loses exit events** — durable queue + `keepalive` flush on page hide.
- **Anonymous → identified** — events before login attribute to the user on `identify()`.
- **Cookieless** (localStorage), consent-friendly (`optIn()` / `optOut()`), SSR-safe.
- Auto-captures SPA pageviews; batches to `/v1/events/batch` with retry/backoff.

Using React or Next? See `@whisperr/react` and `@whisperr/next`.

### Script tag (no build step)

```html
<script>
!function(){var w=window.whisperr=window.whisperr||[];w._opts={};w.load=function(k,o){w._key=k;w._opts=o||{};var s=document.createElement("script");s.async=1;s.src="https://cdn.whisperr.net/whisperr.js";document.head.appendChild(s)};["identify","track","page","flush","reset","optIn","optOut"].forEach(function(m){w[m]=function(){w.push([m].concat([].slice.call(arguments)))}})}();
whisperr.load("wrk_…");
</script>
```

### Options

| Option | Default | |
|---|---|---|
| `apiKey` | — | required |
| `baseUrl` | `https://api.whisperr.net` | ingestion base |
| `flushAt` / `flushIntervalMs` | `20` / `10000` | batch triggers |
| `autocapturePageviews` | `true` | SPA `$pageview` capture |
| `respectDoNotTrack` | `false` | honor DNT |
| `persistence` | `localStorage` | or `memory` |
| `debug` | `false` | verbose logging |

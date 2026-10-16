# @whisperr/web

Tiny, reliable event tracking for Whisperr — works in any JavaScript app.

```bash
npm i @whisperr/web
```

```ts
import { Whisperr } from "@whisperr/web";

const whisperr = Whisperr.init({ apiKey: "wpk_…", appVersion: "2.4.0" });

// after the user logs in / on session restore
whisperr.identify("user_123", { email: "ada@acme.com", traits: { plan: "pro" } });

// when the user picks a language in your product (not the browser locale)
whisperr.setAppLanguage("pt-BR");

// when something happens
whisperr.track("subscription_cancelled", { reason: "too_expensive" });

// on logout
whisperr.reset();
```

- **~3KB gzipped, zero dependencies.** Off the critical path.
- **Never loses exit events** — durable queue + `keepalive` flush on page hide.
- **Anonymous → identified** — before login, behavior is recorded under an anonymous id; `identify()` merges it into the user, and `reset()` starts a new anonymous visitor.
- **Identify on every load** — when a user id is stored from an earlier visit, the SDK sends one identify for that user about 2 seconds after load (skipped when your app identifies the same user first, or when the same identify went out less than 24 hours ago). Users who signed in before you installed the SDK are not known to it: call `identify()` on session restore.
- **App language** — `setAppLanguage(tag)` stores the language the user picked in your product (BCP 47; `_` becomes `-`) and sends it as `traits.app_language`; every later identify carries it, and your own `traits.app_language` wins. Before login it goes to the anonymous visitor. `setAppLanguage(null)` clears the stored value.
- **Versions on every event** — each event's `context` carries `platform: "web"`, `sdk_name`, `sdk_version`, and `app_version` / `app_build` when you set the `appVersion` / `appBuild` options. The SDK never sets `context.locale`; pass it yourself to set the language of one event.
- **Timezone + locale by default** — `identify()` fills `traits.timezone` (IANA, from `Intl`) and `traits.locale` (BCP 47, from `navigator.language`) so quiet hours and message language match the user; your own `traits` values always win, and nothing is sent for a value the browser can't provide.
- **Cookieless** (localStorage), consent-friendly (`optIn()` / `optOut()`), SSR-safe.
- Auto-captures SPA pageviews; batches to `/v1/events/batch` with retry/backoff (honors `Retry-After`).

### Email and consent

`identify(userId, { email })` stores the address and claims no consent. Pass `emailOptedIn` with your user's answer when you have it:

```ts
whisperr.identify("user_123", { email: "ada@acme.com", emailOptedIn: true });
```

`emailOptedIn` needs 0.4.0 or later. It is sent as `opted_in` on the email channel; omit it and nothing is sent. Whether the address then gets messages depends on your app's answer to "Does your signup get permission to email users?" in Whisperr:

- **Yes:** the address is opted in unless you pass `emailOptedIn: false`.
- **Per user:** only `emailOptedIn: true` opts it in.
- **No:** the address gets no messages until your server confirms it.

If your app requires a server key for email (the stricter mode), only your backend can opt an address in, with the server key. Never put the server key in browser code.

Using React or Next? See `@whisperr/react` and `@whisperr/next`.

### Script tag (no build step)

```html
<script>
!function(){var w=window.whisperr=window.whisperr||[];w._opts={};w.load=function(k,o){w._key=k;w._opts=o||{};var s=document.createElement("script");s.async=1;s.src="https://cdn.whisperr.net/whisperr.js";document.head.appendChild(s)};["identify","track","page","setAppLanguage","flush","reset","optIn","optOut"].forEach(function(m){w[m]=function(){w.push([m].concat([].slice.call(arguments)))}})}();
whisperr.load("wpk_…");
</script>
```

### Options

| Option | Default | |
|---|---|---|
| `apiKey` | — | required |
| `baseUrl` | `https://api.whisperr.net` | ingestion base |
| `flushAt` / `flushIntervalMs` | `20` / `10000` | batch triggers |
| `autocapturePageviews` | `true` | SPA `page_viewed` capture |
| `respectDoNotTrack` | `false` | honor DNT |
| `persistence` | `localStorage` | or `memory` |
| `appVersion` / `appBuild` | — | sent as `context.app_version` / `context.app_build` |
| `debug` | `false` | verbose logging |

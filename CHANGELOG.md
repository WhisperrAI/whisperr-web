# Changelog

## 0.4.0 (unreleased)

All three packages release together.

- New `emailOptedIn` on `identify()`: your user's email consent, sent as
  `opted_in` on the `email` shortcut. Whether it opts the address in depends on
  the app's answer to "Does your signup get permission to email users?" in
  Whisperr.
- Behavior change: the `email` shortcut no longer sends `opted_in: true` on
  its own. Without `emailOptedIn` it sends no `opted_in`. An explicit email
  channel with no `optedIn` also leaves `opted_in` off the wire (it used to
  send `true`). Other channels keep their old default. Versions before 0.4.0
  send `opted_in: true` on every email.
- An email channel with `opted_in: true` also sends `consent_source: "user"`.
  The server needs it to grant consent in "Per user" mode, which tells this
  apart from the `true` that older versions sent by default.
- An identify from the app no longer opts an address back in after the user
  opted out of it (including through the unsubscribe link). This rule is
  enforced by the Whisperr backend, which also has to accept
  `consent_source` before this version ships.
- Docs: the browser takes the publishable key (`wpk_…`), not the server key.

## 0.3.0 — 2026-10-12

All three packages (`@whisperr/web`, `@whisperr/react`, `@whisperr/next`)
release together. Requires a backend on whisperr-spec contract v2 (it accepts
an identify with `anonymous_id` and no `external_user_id`).

- Identify on every load: when a user id is stored from an earlier visit, the
  SDK queues one identify for that user (user id, anonymous id, device traits,
  stored app language; no channels) about 2 seconds after load, through the
  ordered queue. It is skipped when the app calls `identify()` first, and when
  the same identify was delivered less than 24 hours ago. A page hide before
  the 2 seconds queues it at once for the exit flush.
- New `setAppLanguage(tag | null)`: stores the language the user picked in the
  product (BCP 47, `_` becomes `-`, invalid values are ignored with a debug
  log) and sends it as `traits.app_language`: a partial identify for the
  current user, or an anonymous identify before login. Every identify carries
  the stored value; a caller-supplied `traits.app_language` wins. `null`
  clears the stored value. An unchanged value sends nothing. Available through
  `useWhisperr()` in `@whisperr/react` and `@whisperr/next`, and in the
  script-tag stub.
- Every event's `context` now carries `platform: "web"`, `sdk_name`,
  `sdk_version`, and `app_version` / `app_build` from the new `appVersion` /
  `appBuild` init options (no value, no key).
- Breaking: the SDK no longer puts the browser locale in `context.locale`. The
  server reads `context.locale` as the message language of that one event, so
  only the caller sets it. The browser locale still goes in `traits.locale`.

## 0.2.1

- The page-hide flush now sends the whole queue that fits the browser's 64 KiB
  keepalive quota (identify and track ops, chunked by `maxBatchSize`) instead of
  only the first batch, so events no longer wait for the next page load. Events
  stay queued until the server confirms them; if the page dies first they are
  resent on the next load with the same `$message_id` (the backend dedups).
  Previously they were dequeued before sending, so a failed or oversized exit
  request lost them.
- Delivered events are removed from the queue by identity rather than position,
  so an exit flush or another tab finishing first can't make a drain drop
  events it never sent.
- Honor `Retry-After` (seconds or HTTP-date) on `429` / `503`: the next retry
  waits that long (capped at 60s) instead of the exponential backoff.

## 0.2.0

- Events tracked before `identify()` are sent right away under an anonymous id
  instead of waiting in the queue for login; `identify()` sends the same id so
  the server merges that anonymous visitor into the user, and `reset()` starts
  a new anonymous visitor. Requires a backend that accepts `anonymous_id`
  (whisperr-spec `conformance/anonymous.json`).
- The anonymous id is a bare UUID v4 (it used to carry an `anon_` prefix); an
  id already stored in a browser is kept as is.

## 0.1.8

- `identify()` automatically captures the device's IANA timezone and BCP 47
  locale when available. Caller-supplied traits take precedence.
- Release `@whisperr/web`, `@whisperr/react`, and `@whisperr/next` together;
  adapters now require the updated core SDK.
- Synchronize the reported SDK version and workspace lockfile versions with
  the published packages.

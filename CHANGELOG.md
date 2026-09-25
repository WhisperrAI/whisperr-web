# Changelog

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

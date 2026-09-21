# Changelog

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

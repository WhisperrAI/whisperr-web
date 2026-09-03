# Changelog

## 0.1.8

- `identify()` automatically captures the device's IANA timezone and BCP 47
  locale when available. Caller-supplied traits take precedence.
- Release `@whisperr/web`, `@whisperr/react`, and `@whisperr/next` together;
  adapters now require the updated core SDK.
- Synchronize the reported SDK version and workspace lockfile versions with
  the published packages.

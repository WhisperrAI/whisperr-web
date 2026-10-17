# @whisperr/react

React bindings for [`@whisperr/web`](https://www.npmjs.com/package/@whisperr/web).

```bash
npm i @whisperr/react @whisperr/web
```

```tsx
import { WhisperrProvider, useWhisperr } from "@whisperr/react";

function App() {
  return (
    <WhisperrProvider apiKey="wpk_…">
      <ExportButton />
    </WhisperrProvider>
  );
}

function ExportButton() {
  const whisperr = useWhisperr();
  // track your app's core action; this event name is only an example
  return (
    <button onClick={() => whisperr.track("report_exported", { format: "pdf" })}>
      Export
    </button>
  );
}
```

Initialization is idempotent (safe under StrictMode) and SSR-safe.

`useWhisperr()` returns the full `@whisperr/web` client, including
`setAppLanguage(tag)`:

```tsx
const whisperr = useWhisperr();
useEffect(() => whisperr.setAppLanguage(i18n.language), [i18n.language]);
```

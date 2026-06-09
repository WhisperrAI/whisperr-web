# @whisperr/react

React bindings for [`@whisperr/web`](https://www.npmjs.com/package/@whisperr/web).

```bash
npm i @whisperr/react @whisperr/web
```

```tsx
import { WhisperrProvider, useWhisperr } from "@whisperr/react";

function App() {
  return (
    <WhisperrProvider apiKey="wrk_…">
      <Checkout />
    </WhisperrProvider>
  );
}

function Checkout() {
  const whisperr = useWhisperr();
  return (
    <button onClick={() => whisperr.track("checkout_started", { cart_value: 49 })}>
      Buy
    </button>
  );
}
```

Initialization is idempotent (safe under StrictMode) and SSR-safe.

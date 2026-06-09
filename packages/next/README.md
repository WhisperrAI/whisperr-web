# @whisperr/next

Next.js (App Router) bindings for [`@whisperr/web`](https://www.npmjs.com/package/@whisperr/web).

```bash
npm i @whisperr/next @whisperr/web
```

`app/layout.tsx` (a server component — the provider is a client boundary):

```tsx
import { WhisperrProvider } from "@whisperr/next";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        <WhisperrProvider apiKey={process.env.NEXT_PUBLIC_WHISPERR_KEY!}>
          {children}
        </WhisperrProvider>
      </body>
    </html>
  );
}
```

Then in any client component:

```tsx
"use client";
import { useWhisperr } from "@whisperr/next";

export function CancelButton() {
  const whisperr = useWhisperr();
  return <button onClick={() => whisperr.track("subscription_cancelled")}>Cancel</button>;
}
```

Pageviews are auto-captured via the History API (covers Next client navigation).

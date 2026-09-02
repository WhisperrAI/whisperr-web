// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Whisperr } from "./index.js";
import { deviceTraits } from "./runtime.js";

// @whisperr/next renders <WhisperrProvider> inside server components; the core
// must resolve device traits without a window (no throw, no server-side guess).
describe("SSR (no window / navigator)", () => {
  it("deviceTraits() is empty outside a browser and never throws", () => {
    expect(typeof window).toBe("undefined");
    expect(deviceTraits()).toEqual({});
  });

  it("identify() on the server-side no-op client does not throw", () => {
    const w = Whisperr.init({ apiKey: "wrk_test" });
    expect(w.ready).toBe(false);
    expect(() => w.identify("u1", { traits: { plan: "pro" } })).not.toThrow();
    expect(() => w.identify("u1")).not.toThrow();
  });
});

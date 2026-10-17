// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The harness pins the device locale/timezone per case (automatic.json → device).
const device = vi.hoisted(() => ({ traits: {} as Record<string, string> }));
vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  deviceTraits: () => ({ ...device.traits }),
}));

import { WhisperrClient } from "./client.js";
import { wireEvent } from "./transport.js";
import { errorFingerprint, landingProperties, redactRoute, stackFunctionNames } from "./signals.js";
import type { TrackOp, WhisperrOptions } from "./types.js";

const SPEC_URL = "https://raw.githubusercontent.com/WhisperrAI/whisperr-spec/main/conformance/automatic.json";
const realFetch = globalThis.fetch.bind(globalThis);
const SESSION = /^sess_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function loadAutomatic(): Promise<any> {
  const local = process.env.WHISPERR_SPEC_AUTOMATIC_PATH;
  if (local) return JSON.parse(readFileSync(local, "utf8"));
  const res = await realFetch(SPEC_URL);
  if (!res.ok) throw new Error(`fetch automatic spec: ${res.status}`);
  return res.json();
}

let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });

function setVisibility(v: DocumentVisibilityState): void {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
}

function setUrl(url: string): void {
  (globalThis as unknown as { jsdom: { reconfigure(o: { url: string }): void } }).jsdom.reconfigure({ url });
}

const clients: WhisperrClient[] = [];
function client(opts: Partial<WhisperrOptions> = {}): WhisperrClient {
  // Requests never settle, so every event stays in the queue for inspection.
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  const c = new WhisperrClient({ apiKey: "wpk_test", persistence: "memory", autocapturePageviews: false, ...opts });
  clients.push(c);
  return c;
}

function sent(c: WhisperrClient): any[] {
  return ((c as unknown as { queue: { all: TrackOp[] } }).queue.all as TrackOp[])
    .filter((op) => op.kind === "track")
    .map((op) => wireEvent(op));
}
const named = (c: WhisperrClient, type: string) => sent(c).filter((e) => e.event_type === type);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  visibility = "visible";
  device.traits = {};
  setUrl("https://app.example.com/");
});
afterEach(() => {
  // Detach the previous clients' listeners by muting them.
  for (const c of clients.splice(0)) (c as unknown as { muted: boolean }).muted = true;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("signalsV3 helpers", () => {
  it("matches the spec fingerprint vectors", async () => {
    const spec = await loadAutomatic();
    for (const v of spec.signalsV3.fingerprintVectors) {
      expect(errorFingerprint(v.errorName, v.frames)).toBe(v.fingerprint);
    }
  });

  it("reads function names from V8 and Firefox stacks, without paths or positions", () => {
    const v8 = "TypeError: boom\n    at loadCart (https://x.io/a.js?v=1:10:5)\n    at async CartScreen (https://x.io/b.js:1:1)\n    at https://x.io/c.js:3:3\n    at new Foo (https://x.io/d.js:4:4)\n    at bar (x.js:1:1)";
    expect(stackFunctionNames(v8)).toEqual(["loadCart", "CartScreen", "Foo"]);
    // A V8 header whose message contains "@" is not a frame.
    expect(stackFunctionNames("Error: mail ada@x.io failed\n    at send (x.js:1:1)")).toEqual(["send"]);
    expect(stackFunctionNames("loadCart@https://x.io/a.js:10:5\n@https://x.io/c.js:1:1\nCartScreen@x.js:2:2")).toEqual([
      "loadCart",
      "CartScreen",
    ]);
  });

  it("redacts ids out of the route", () => {
    expect(redactRoute("/orders/12345/items/3f2b8c1e-9d4a-4b7e-8c2f-1a2b3c4d5e6f")).toBe("/orders/:id/items/:id");
    expect(redactRoute("/magic/Zx9QmT4pLw8KvR2nB7")).toBe("/magic/:id");
    expect(redactRoute("/settings/profile")).toBe("/settings/profile");
    expect(landingProperties("https://a.io/x?wsrc=widget&utm_source=s")).toEqual({
      launch_source: "widget",
      link_host: "a.io",
      link_route: "/x",
      utm_source: "s",
    });
  });
});

describe("signalsV3.web conformance (whisperr-spec automatic.json)", async () => {
  const spec = await loadAutomatic();
  const section = spec.signalsV3.sections.web;
  const COMPARED = new Set(["app_opened", "app_backgrounded", "app_error"]);

  for (const kase of section.cases) {
    it(kase.name, () => {
      device.traits = { ...kase.device };
      let c: WhisperrClient | undefined;
      for (const step of kase.steps) {
        if (step.launch) {
          setUrl(step.launch.url);
          visibility = "visible";
          c = client();
        } else if (step.background) {
          vi.advanceTimersByTime(step.background.afterMs);
          setVisibility("hidden");
        } else if (step.foreground) {
          vi.advanceTimersByTime(step.foreground.afterMs);
          setVisibility("visible");
        } else {
          throw new Error(`unknown step ${JSON.stringify(step)}`);
        }
      }
      const placeholders: Record<string, unknown> = {
        $platform: "web",
        $sdk_name: "whisperr-web",
        $sdk_version: expect.any(String),
      };
      const sessions = new Map<string, string>();
      const events = sent(c!).filter((e) => COMPARED.has(e.event_type));
      expect(events.map((e) => e.event_type)).toEqual(kase.expectedEvents.map((e: any) => e.event_type));
      kase.expectedEvents.forEach((exp: any, i: number) => {
        const got = events[i];
        const sid = got.context.session_id;
        expect(sid).toMatch(SESSION);
        const ph = exp.context.session_id as string;
        if (!sessions.has(ph)) {
          expect([...sessions.values()]).not.toContain(sid);
          sessions.set(ph, sid);
        }
        expect(sid).toBe(sessions.get(ph));
        const want = Object.fromEntries(
          Object.entries(exp.properties).map(([k, v]) => [
            k,
            typeof v === "string" && v.startsWith("$session_") ? sessions.get(v) : (placeholders[v as string] ?? v),
          ]),
        );
        expect(got.properties).toEqual(want);
      });
    });
  }
});

describe("visit counters", () => {
  it("counts page views, distinct pages and customer events of the visible period", () => {
    const c = client();
    c.page("Home");
    c.page("Cart");
    c.page("Home");
    c.track("added_to_cart");
    c.track("app_opened"); // reserved names never count as customer events
    vi.advanceTimersByTime(4200);
    setVisibility("hidden");
    window.dispatchEvent(new Event("pagehide")); // same exit: no second app_backgrounded
    const [bg, ...rest] = named(c, "app_backgrounded");
    expect(rest).toHaveLength(0);
    expect(bg.properties).toMatchObject({
      foreground_ms: 4200,
      screen_count: 3,
      unique_screen_count: 2,
      event_count: 1,
      error_count: 0,
      session_id: bg.context.session_id,
    });

    setVisibility("visible");
    c.track("checkout_started");
    setVisibility("hidden");
    expect(named(c, "app_backgrounded")[1].properties).toMatchObject({ screen_count: 0, event_count: 1 });
  });

  it("hiding a tab idle for over 30 min starts no session: no app_opened, old session id", () => {
    const c = client();
    const [opened] = named(c, "app_opened");
    vi.advanceTimersByTime(31 * 60 * 1000);
    window.dispatchEvent(new ErrorEvent("error", { error: new TypeError("late") }));
    setVisibility("hidden");
    expect(named(c, "app_opened")).toHaveLength(1);
    const [bg] = named(c, "app_backgrounded");
    expect(bg.context.session_id).toBe(opened.context.session_id);
    expect(bg.properties.session_id).toBe(opened.context.session_id);
    expect(named(c, "app_error")[0].context.session_id).toBe(opened.context.session_id);
  });

    it("puts the same session_id on every event", () => {
    const c = client();
    c.track("a");
    c.trackError(new Error("x"));
    setVisibility("hidden");
    const ids = new Set(sent(c).map((e) => e.context.session_id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(SESSION);
  });
});

describe("app_error", () => {
  function throwIn(fnName: string, name = "TypeError"): Error {
    const e = new Error("secret message with user@example.com");
    e.name = name;
    e.stack = `${name}: secret\n    at ${fnName} (https://x.io/app.js?token=abc:1:2)`;
    return e;
  }

  it("captures uncaught errors and rejections with name and fingerprint only", () => {
    const c = client();
    c.page("Checkout");
    window.dispatchEvent(new ErrorEvent("error", { error: throwIn("pay"), message: "secret" }));
    const rejection = new Event("unhandledrejection") as Event & { reason: unknown };
    rejection.reason = "plain string";
    window.dispatchEvent(rejection);
    const errors = named(c, "app_error");
    expect(errors).toHaveLength(2);
    expect(errors[0].properties).toMatchObject({
      error_kind: "js",
      fatal: false,
      error_name: "TypeError",
      fingerprint: errorFingerprint("TypeError", ["pay"]),
      screen_name: "Checkout",
      session_id: errors[0].context.session_id,
    });
    expect(errors[1].properties).toMatchObject({ error_name: "UnhandledRejection", error_kind: "js" });
    const json = JSON.stringify(errors.map((e) => e.properties));
    expect(json).not.toContain("secret");
    expect(json).not.toContain("token");
  });

  it("ignores a cross-origin Script error with no error object", () => {
    const c = client();
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
    expect(named(c, "app_error")).toHaveLength(0);
  });

  it("dedupes by fingerprint, caps at 20 per session, and error_count keeps the true total", () => {
    const c = client();
    c.trackError(throwIn("same"));
    c.trackError(throwIn("same"));
    for (let i = 0; i < 30; i++) c.trackError(throwIn(`fn${i}`));
    expect(named(c, "app_error")).toHaveLength(20);
    setVisibility("hidden");
    expect(named(c, "app_backgrounded")[0].properties.error_count).toBe(32);
  });

  it("trackError defaults to handled and takes screen and kind", () => {
    const c = client();
    c.trackError(throwIn("a"));
    c.trackError(throwIn("b"), { screen: "Offers", kind: "network" });
    const [a, b] = named(c, "app_error");
    expect(a.properties.error_kind).toBe("handled");
    expect(b.properties).toMatchObject({ error_kind: "network", screen_name: "Offers" });
  });

  it("captureErrors: false stops automatic capture, trackError still sends", () => {
    const c = client({ captureErrors: false });
    window.dispatchEvent(new ErrorEvent("error", { error: throwIn("x") }));
    expect(named(c, "app_error")).toHaveLength(0);
    c.trackError(throwIn("y"));
    expect(named(c, "app_error")).toHaveLength(1);
    expect(named(c, "app_opened")).toHaveLength(1);
  });

  it("automaticEvents: false sends no automatic events, trackError still sends", () => {
    const c = client({ automaticEvents: false, autocapturePageviews: undefined });
    window.dispatchEvent(new ErrorEvent("error", { error: throwIn("x") }));
    setVisibility("hidden");
    setVisibility("visible");
    c.trackError(throwIn("y"));
    expect(sent(c).map((e) => e.event_type)).toEqual(["app_error"]);
    expect(sent(c)[0].context.session_id).toMatch(SESSION);
  });

  it("an opted-out client sends nothing", () => {
    const c = client();
    c.optOut();
    c.trackError(throwIn("y"));
    window.dispatchEvent(new ErrorEvent("error", { error: throwIn("x") }));
    setVisibility("hidden");
    expect(sent(c)).toHaveLength(0);
    c.optIn();
  });
});

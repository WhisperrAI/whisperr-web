import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhisperrClient } from "./client.js";
import type { WhisperrOptions } from "./types.js";

// Exit flush: when the page is hidden/unloaded, queued events go out right
// away over keepalive fetch (within the 64 KiB keepalive quota) and stay
// persisted until a response confirms them (at-least-once; the backend dedups
// on context.$message_id).

class TestStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}
const testLS = new TestStorage();
Object.defineProperty(window, "localStorage", { value: testLS, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: testLS, configurable: true });

const settle = () => new Promise((r) => setTimeout(r, 0));

const QUEUE_KEY = "whisperr.queue.v1";
const KEEPALIVE_QUOTA = 64 * 1024;

interface Call {
  path: string;
  raw: string;
  body: any;
  key: string;
  keepalive: boolean;
  resolve: (status: number) => void;
  reject: (err: unknown) => void;
}

let calls: Call[];
/** Every request of the current test, so teardown can settle the ones left pending. */
let allCalls: Call[];
/** "auto" answers every request with 200; "manual" leaves it pending until resolved. */
let mode: "auto" | "manual";
let clients: WhisperrClient[];

beforeEach(() => {
  calls = [];
  allCalls = [];
  mode = "auto";
  clients = [];
  testLS.clear();
  setVisibility("visible");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string, init: any) =>
        new Promise((resolve, reject) => {
          const call: Call = {
            path: url.replace("https://api.whisperr.net", ""),
            raw: init.body,
            body: JSON.parse(init.body),
            key: init.headers["X-API-Key"],
            keepalive: init.keepalive,
            resolve: (status) => resolve({ ok: status >= 200 && status < 300, status } as Response),
            reject,
          };
          calls.push(call);
          allCalls.push(call);
          if (mode === "auto") call.resolve(200);
        }),
    ),
  );
});

afterEach(async () => {
  // Settle requests a test left in flight: pending keepalive bytes count
  // against the page-wide quota, which outlives a single test.
  for (const c of allCalls) c.reject(new Error("test teardown"));
  await settle();
  // Listeners live on the shared jsdom window; mute finished clients so they
  // don't answer later tests' hide events.
  for (const c of clients) c.optOut();
  vi.unstubAllGlobals();
});

function makeClient(extra: Partial<WhisperrOptions> = {}): WhisperrClient {
  const w = new WhisperrClient({
    apiKey: "wrk_test",
    flushIntervalMs: 1e9,
    autocapturePageviews: false,
    ...extra,
  });
  clients.push(w);
  return w;
}

/** A client whose startup drain has settled, with `calls` reset. */
async function settledClient(extra: Partial<WhisperrOptions> = {}): Promise<WhisperrClient> {
  const w = makeClient(extra);
  await w.flush();
  calls = [];
  return w;
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

function hide() {
  setVisibility("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
}

function persisted(): any[] {
  return JSON.parse(testLS.getItem(QUEUE_KEY) ?? "[]");
}

function sentTypes(): string[] {
  return calls.filter((c) => c.path === "/v1/events/batch").flatMap((c) => c.body.events.map((e: any) => e.event_type));
}

describe("exit flush", () => {
  it("sends the queue with keepalive + the API key when the page becomes hidden", async () => {
    const w = await settledClient();
    w.identify("u1");
    w.track("a");
    w.track("b");
    calls = []; // identify() kicked off a normal flush; exit flush is what we assert on
    mode = "manual";

    hide();

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.keepalive && c.key === "wrk_test")).toBe(true);
    expect(sentTypes()).toEqual(["a", "b"]);
  });

  it("flushes on pagehide", async () => {
    const w = await settledClient();
    w.identify("u1");
    w.track("a");
    calls = [];
    mode = "manual";

    window.dispatchEvent(new Event("pagehide"));

    expect(sentTypes()).toEqual(["a"]);
    expect(calls[0]!.keepalive).toBe(true);
  });

  it("sends identify and track ops together (not just the front group)", async () => {
    const w = await settledClient();
    mode = "manual"; // keep everything queued
    w.track("before_login");
    w.identify("u1");
    w.track("after_login");
    calls = [];

    window.dispatchEvent(new Event("pagehide"));

    expect(calls.some((c) => c.path === "/v1/identify" && c.keepalive)).toBe(true);
    expect(sentTypes().sort()).toEqual(["after_login", "before_login"]);
  });

  it("does nothing while the page stays visible", async () => {
    const w = await settledClient();
    mode = "manual";
    w.track("a");
    calls = [];
    document.dispatchEvent(new Event("visibilitychange"));
    expect(calls).toHaveLength(0);
  });

  it("is a no-op when the queue is empty", async () => {
    await settledClient();
    hide();
    window.dispatchEvent(new Event("pagehide"));
    expect(calls).toHaveLength(0);
  });

  it("chunks into keepalive requests that together stay under the 64 KiB quota", async () => {
    const w = await settledClient({ maxBatchSize: 4 });
    mode = "manual";
    const blob = "x".repeat(4000);
    for (let i = 0; i < 30; i++) w.track("big_event", { i, blob }); // ~120 KB queued
    calls = [];

    window.dispatchEvent(new Event("pagehide"));

    expect(calls.length).toBeGreaterThan(1);
    const total = calls.reduce((n, c) => n + new TextEncoder().encode(c.raw).length, 0);
    expect(total).toBeLessThanOrEqual(KEEPALIVE_QUOTA);
    expect(calls.every((c) => c.keepalive && c.body.events.length <= 4)).toBe(true);
    const sent = calls.flatMap((c) => c.body.events.map((e: any) => e.properties.i));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(30);

    // Confirmed chunks leave the queue; what didn't fit waits for the next load.
    for (const c of calls) c.resolve(200);
    await settle();
    const left = persisted().map((op: any) => op.properties.i);
    expect(left).toHaveLength(30 - sent.length);
    expect(left.some((i: number) => sent.includes(i))).toBe(false);
  });

  it("keeps a non-ASCII payload under the quota (counts UTF-8 bytes, not chars)", async () => {
    const w = await settledClient();
    mode = "manual";
    const blob = "€".repeat(3000); // 9000 UTF-8 bytes, 3000 chars
    for (let i = 0; i < 12; i++) w.track("big_event", { i, blob });
    calls = [];

    window.dispatchEvent(new Event("pagehide"));

    const total = calls.reduce((n, c) => n + new TextEncoder().encode(c.raw).length, 0);
    expect(total).toBeLessThanOrEqual(KEEPALIVE_QUOTA);
    expect(sentTypes().length).toBeGreaterThan(0);
  });

  it("skips an event too large for keepalive but still sends the rest", async () => {
    const w = await settledClient();
    mode = "manual";
    w.track("huge", { blob: "x".repeat(70 * 1024) });
    w.track("small");
    calls = [];

    window.dispatchEvent(new Event("pagehide"));

    expect(sentTypes()).toEqual(["small"]);
    calls[0]!.resolve(200);
    await settle();
    expect(persisted().map((op: any) => op.eventType)).toEqual(["huge"]);
  });

  it("keeps events persisted until confirmed; the next load resends them with the same $message_id", async () => {
    const w = await settledClient();
    mode = "manual";
    w.identify("u1");
    w.track("checkout_abandoned");
    calls = [];

    window.dispatchEvent(new Event("pagehide")); // page dies before any response
    const exitEvent = calls.find((c) => c.path === "/v1/events/batch")!.body.events[0];
    expect(persisted().map((op: any) => op.kind)).toEqual(["identify", "track"]);

    // Next page load: a fresh client drains the persisted queue.
    calls = [];
    mode = "auto";
    const next = makeClient();
    await next.flush();
    const resent = calls.find((c) => c.path === "/v1/events/batch")!.body.events[0];
    expect(resent.event_type).toBe("checkout_abandoned");
    expect(resent.context.$message_id).toBe(exitEvent.context.$message_id); // server dedups
    expect(persisted()).toHaveLength(0);
  });

  it("retains events when the keepalive request fails (e.g. quota or network error)", async () => {
    const w = await settledClient();
    mode = "manual";
    w.track("a");
    calls = [];

    window.dispatchEvent(new Event("pagehide"));
    calls[0]!.reject(new TypeError("Failed to fetch"));
    await settle();

    expect(persisted().map((op: any) => op.eventType)).toEqual(["a"]);
  });

  it("puts each op in flight once across client instances and repeated hide events", async () => {
    const a = await settledClient();
    makeClient(); // second instance on the same page, same persisted queue
    await settle();
    mode = "manual";
    a.track("x");
    a.track("y");
    calls = [];

    hide(); // visibilitychange → hidden
    window.dispatchEvent(new Event("pagehide")); // then pagehide, as browsers fire both

    expect(sentTypes().sort()).toEqual(["x", "y"]);

    // Once settled, a later hide can send what's still queued again.
    for (const c of calls) c.reject(new TypeError("offline"));
    await settle();
    calls = [];
    window.dispatchEvent(new Event("pagehide"));
    expect(sentTypes().sort()).toEqual(["x", "y"]);
  });

  it("a drain finishing after an exit flush removes only what it sent", async () => {
    const w = await settledClient();
    w.identify("u1");
    await w.flush();
    mode = "manual";
    w.track("a");
    w.track("b");
    calls = [];

    const draining = w.flush(); // normal drain: [a, b] in flight
    await settle();
    const drainCall = calls[0]!;
    mode = "auto";
    window.dispatchEvent(new Event("pagehide")); // exit flush delivers a, b (tab stays alive)
    await settle();
    expect(persisted()).toHaveLength(0);

    w.track("c");
    w.track("d");
    mode = "manual";
    drainCall.resolve(200); // the slow drain response lands afterwards
    await settle();

    // Removal is by identity: c and d are still queued (a positional
    // removeFront(2) would have dropped them unsent).
    expect(persisted().map((op: any) => op.eventType)).toEqual(["c", "d"]);
    for (const c of calls) c.resolve(200); // let the drain finish [c, d]
    await draining;
    expect(persisted()).toHaveLength(0);
  });
});

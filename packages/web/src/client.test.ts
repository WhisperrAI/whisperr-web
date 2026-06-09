import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhisperrClient } from "./client.js";
import type { WhisperrOptions } from "./types.js";

// jsdom ships a non-functional localStorage stub, which would make the SDK fall
// back to a per-instance memory store. Install a real shared Map-backed Storage
// so persistence + multi-tab behavior is actually exercised, like a browser.
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
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  get length() {
    return this.m.size;
  }
}
const testLS = new TestStorage();
Object.defineProperty(window, "localStorage", { value: testLS, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: testLS, configurable: true });

interface Captured {
  path: string;
  body: any;
  key: string;
}

let captured: Captured[];
let fetchMock: ReturnType<typeof vi.fn>;

function mockFetch(responder: (path: string) => { ok: boolean; status: number }) {
  fetchMock = vi.fn(async (url: string, init: any) => {
    const path = url.replace("https://api.whisperr.net", "");
    captured.push({ path, body: JSON.parse(init.body), key: init.headers["X-API-Key"] });
    return responder(path) as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}

function makeClient(extra: Partial<WhisperrOptions> = {}): WhisperrClient {
  return new WhisperrClient({
    apiKey: "wrk_test",
    flushIntervalMs: 1e9,
    autocapturePageviews: false,
    ...extra,
  });
}

beforeEach(() => {
  captured = [];
  testLS.clear();
  mockFetch(() => ({ ok: true, status: 200 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("identity continuity", () => {
  it("buffers pre-identify events, then backfills + sends them on identify()", async () => {
    const w = makeClient();
    w.track("offer_viewed", { id: 1 });
    await w.flush();
    expect(captured).toHaveLength(0); // nothing sent before identify

    w.identify("user_123", { email: "a@b.c" });
    await vi.waitFor(() => expect(captured.length).toBeGreaterThanOrEqual(2));

    const batch = captured.find((c) => c.path === "/v1/events/batch");
    expect(batch?.body.events[0].external_user_id).toBe("user_123");
    expect(batch?.body.events[0].event_type).toBe("offer_viewed");

    const identify = captured.find((c) => c.path === "/v1/identify");
    expect(identify?.body.channels[0]).toMatchObject({ type: "email", address: "a@b.c" });
  });
});

describe("batching", () => {
  it("coalesces multiple tracks into one batch request", async () => {
    const w = makeClient();
    w.identify("u1");
    w.track("a");
    w.track("b");
    w.track("c");
    await w.flush();
    const batches = captured.filter((c) => c.path === "/v1/events/batch");
    expect(batches).toHaveLength(1);
    expect(batches[0]!.body.events).toHaveLength(3);
  });
});

describe("idempotency", () => {
  it("stamps each event with a $message_id in context", async () => {
    const w = makeClient();
    w.identify("u1");
    w.track("a");
    await w.flush();
    const batch = captured.find((c) => c.path === "/v1/events/batch")!;
    expect(batch.body.events[0].context.$message_id).toMatch(/[0-9a-f-]{36}/);
  });
});

describe("delivery resilience", () => {
  it("pauses + reports onError on 401, keeping events queued", async () => {
    const errors: any[] = [];
    mockFetch(() => ({ ok: false, status: 401 }));
    const w = makeClient({ onError: (e) => errors.push(e) });
    w.identify("u1");
    w.track("a");
    await w.flush();
    expect(errors.some((e) => e.type === "auth")).toBe(true);
    // queue retained for a later attempt
    mockFetch(() => ({ ok: true, status: 200 }));
    await w.flush();
    expect(captured.some((c) => c.path === "/v1/events/batch")).toBe(true);
  });

  it("drops + reports onError on a permanent 4xx", async () => {
    const errors: any[] = [];
    mockFetch(() => ({ ok: false, status: 400 }));
    const w = makeClient({ onError: (e) => errors.push(e) });
    w.identify("u1");
    w.track("a");
    await w.flush();
    expect(errors.some((e) => e.type === "dropped")).toBe(true);
  });

  it("retries a 5xx then succeeds", async () => {
    let calls = 0;
    fetchMock = vi.fn(async (url: string, init: any) => {
      const path = url.replace("https://api.whisperr.net", "");
      calls++;
      if (path === "/v1/events/batch" && calls <= 2) return { ok: false, status: 503 } as Response;
      captured.push({ path, body: JSON.parse(init.body), key: init.headers["X-API-Key"] });
      return { ok: true, status: 200 } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const w = makeClient({ maxRetries: 5 });
    w.identify("u1");
    w.track("a");
    await w.flush();
    expect(captured.some((c) => c.path === "/v1/events/batch")).toBe(true);
  }, 15000);
});

describe("queue", () => {
  it("drops oldest on overflow", async () => {
    const w = makeClient({ maxQueueSize: 2 });
    w.identify("u1");
    w.track("a");
    w.track("b");
    w.track("c"); // overflow: identify or "a" dropped
    await w.flush();
    const events = captured.filter((c) => c.path === "/v1/events/batch").flatMap((c) => c.body.events);
    const types = events.map((e: any) => e.event_type);
    expect(types).toContain("c");
    expect(types).not.toContain("a");
  });

  it("survives a restart (new instance) via persisted storage", async () => {
    const a = makeClient();
    a.track("persisted"); // buffered (no identify) -> persisted to localStorage
    void a;

    const b = makeClient(); // fresh instance, same localStorage
    b.identify("u1");
    await vi.waitFor(() => expect(captured.some((c) => c.path === "/v1/events/batch")).toBe(true));
    const batch = captured.find((c) => c.path === "/v1/events/batch")!;
    expect(batch.body.events.map((e: any) => e.event_type)).toContain("persisted");
  });

  it("two tabs sharing storage do not clobber each other (read-modify-write)", () => {
    const tabA = makeClient();
    const tabB = makeClient();
    tabA.track("from_a");
    tabB.track("from_b");
    const raw = JSON.parse(localStorage.getItem("whisperr.queue.v1")!);
    const types = raw.map((o: any) => o.eventType);
    expect(types).toContain("from_a");
    expect(types).toContain("from_b");
  });
});

describe("consent + reset", () => {
  it("optOut clears the queue and makes track a no-op", async () => {
    const w = makeClient();
    w.identify("u1");
    w.track("a");
    w.optOut();
    w.track("b");
    await w.flush();
    expect(captured).toHaveLength(0);
  });

  it("reset clears the identified user", async () => {
    const w = makeClient();
    w.identify("u1");
    await w.flush();
    captured = [];
    w.reset();
    w.track("after_reset"); // back to anonymous -> buffered, not sent
    await w.flush();
    expect(captured.some((c) => c.path === "/v1/events/batch")).toBe(false);
  });
});

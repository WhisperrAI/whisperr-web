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
  keepalive?: boolean;
}

let captured: Captured[];
let fetchMock: ReturnType<typeof vi.fn>;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function mockFetch(responder: (path: string) => { ok: boolean; status: number }) {
  fetchMock = vi.fn(async (url: string, init: any) => {
    const path = url.replace("https://api.whisperr.net", "");
    captured.push({ path, body: JSON.parse(init.body), key: init.headers["X-API-Key"], keepalive: init.keepalive });
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
  it("sends pre-identify events right away under an anonymous id, with no user id", async () => {
    const w = makeClient();
    w.track("offer_viewed", { id: 1 });
    await w.flush();

    const batch = captured.find((c) => c.path === "/v1/events/batch")!;
    const ev = batch.body.events[0];
    expect(ev.event_type).toBe("offer_viewed");
    expect(ev.anonymous_id).toMatch(UUID_V4);
    expect(ev).not.toHaveProperty("external_user_id");
  });

  it("identify() carries the same anonymous id so the server can promote it", async () => {
    const w = makeClient();
    w.track("offer_viewed");
    await w.flush();
    const anon = captured.find((c) => c.path === "/v1/events/batch")!.body.events[0].anonymous_id;

    w.identify("user_123", { email: "a@b.c" });
    await w.flush();
    const identify = captured.find((c) => c.path === "/v1/identify")!;
    expect(identify.body.external_user_id).toBe("user_123");
    expect(identify.body.anonymous_id).toBe(anon);
    expect(identify.body.channels[0]).toMatchObject({ channel: "email", address: "a@b.c" });
  });

  it("backfills the user id onto pre-identify events still queued when identify() runs", async () => {
    const w = makeClient();
    w.track("offer_viewed");
    w.identify("user_123");
    await w.flush();

    const batch = captured.find((c) => c.path === "/v1/events/batch")!;
    expect(batch.body.events[0].external_user_id).toBe("user_123");
    expect(batch.body.events[0]).not.toHaveProperty("anonymous_id");
  });

  it("keeps the anonymous id stable across page loads (new instance, same storage)", async () => {
    const a = makeClient();
    a.track("first");
    await a.flush();
    const b = makeClient();
    b.track("second");
    await b.flush();
    const ids = captured.filter((c) => c.path === "/v1/events/batch").map((c) => c.body.events[0].anonymous_id);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
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

  it("drops invalid event types before they can poison a batch", async () => {
    const errors: any[] = [];
    const w = makeClient({ onError: (e) => errors.push(e) });
    w.identify("u1");
    w.track("User Signed Up");
    w.track("checkout_completed");
    await w.flush();

    expect(errors.some((e) => e.type === "dropped")).toBe(true);
    const batch = captured.find((c) => c.path === "/v1/events/batch");
    expect(batch?.body.events).toHaveLength(1);
    expect(batch?.body.events[0].event_type).toBe("checkout_completed");
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
    await a.flush(); // settle the startup drain so the event below stays queued
    a.track("persisted"); // queued, never flushed -> persisted to localStorage
    void a;

    const b = makeClient(); // fresh instance, same localStorage: its startup drain sends it
    await vi.waitFor(() => expect(captured.some((c) => c.path === "/v1/events/batch")).toBe(true));
    const batch = captured.find((c) => c.path === "/v1/events/batch")!;
    expect(batch.body.events.map((e: any) => e.event_type)).toContain("persisted");
  });

  it("sends events queued by a pre-0.2 SDK (no anonymousId) under the current anonymous id", async () => {
    localStorage.setItem(
      "whisperr.queue.v1",
      JSON.stringify([
        { kind: "track", eventType: "legacy", externalUserId: null, occurredAt: new Date().toISOString(), messageId: "m1" },
      ]),
    );
    const w = makeClient();
    await w.flush();
    const ev = captured.find((c) => c.path === "/v1/events/batch")!.body.events[0];
    expect(ev.event_type).toBe("legacy");
    expect(ev.anonymous_id).toBe(localStorage.getItem("whisperr.anon_id"));
    expect(ev).not.toHaveProperty("external_user_id");
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

  it("reset() drops the user and starts a new anonymous visitor", async () => {
    const w = makeClient();
    w.track("before_login");
    await w.flush();
    const first = captured.find((c) => c.path === "/v1/events/batch")!.body.events[0].anonymous_id;
    w.identify("u1");
    await w.flush();
    captured = [];

    w.reset();
    w.track("after_reset");
    await w.flush();
    const ev = captured.find((c) => c.path === "/v1/events/batch")!.body.events[0];
    expect(ev).not.toHaveProperty("external_user_id");
    expect(ev.anonymous_id).toMatch(UUID_V4);
    expect(ev.anonymous_id).not.toBe(first);
  });

  it("events queued before reset() keep the identity they were tracked under", async () => {
    const w = makeClient();
    w.identify("u1");
    w.track("before_logout");
    w.reset();
    w.track("after_logout");
    await w.flush();
    const events = captured.filter((c) => c.path === "/v1/events/batch").flatMap((c) => c.body.events);
    expect(events.find((e: any) => e.event_type === "before_logout").external_user_id).toBe("u1");
    expect(events.find((e: any) => e.event_type === "after_logout")).not.toHaveProperty("external_user_id");
  });
});

describe("exit flush", () => {
  it("sends pre-identify events on page hide with keepalive instead of holding them back", () => {
    const w = makeClient();
    w.track("exit_intent");
    window.dispatchEvent(new Event("pagehide"));
    const call = captured.find((c) => c.path === "/v1/events/batch");
    expect(call).toBeTruthy();
    expect(call!.keepalive).toBe(true);
    expect(call!.body.events[0].anonymous_id).toMatch(UUID_V4);
  });
});

describe("device traits (reserved identify keys: timezone / locale)", () => {
  let resolved: ReturnType<typeof vi.spyOn> | null = null;

  /** Pretend the browser reports this zone + language (undefined = unavailable). */
  function stubDevice(timeZone: string | undefined, language: string | undefined) {
    resolved = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ timeZone } as unknown as Intl.ResolvedDateTimeFormatOptions);
    Object.defineProperty(navigator, "language", { value: language, configurable: true });
  }

  afterEach(() => {
    resolved?.mockRestore();
    resolved = null;
    delete (navigator as unknown as { language?: string }).language;
  });

  async function identifyBody(w: WhisperrClient): Promise<any> {
    await w.flush();
    return captured.find((c) => c.path === "/v1/identify")!.body;
  }

  it("fills traits.timezone (IANA) and traits.locale (BCP 47) from the browser", async () => {
    stubDevice("Europe/Berlin", "de-DE");
    const w = makeClient();
    w.identify("u1", { traits: { plan: "pro" } });
    const body = await identifyBody(w);
    expect(body.traits).toEqual({ plan: "pro", timezone: "Europe/Berlin", locale: "de-DE" });
    expect(Object.keys(body)).toEqual(["external_user_id", "anonymous_id", "traits"]); // still inside traits, never top-level
  });

  it("populates the defaults even when identify() is called with no params", async () => {
    stubDevice("America/Sao_Paulo", "pt-BR");
    const w = makeClient();
    w.identify("u1");
    const body = await identifyBody(w);
    expect(body.traits).toEqual({ timezone: "America/Sao_Paulo", locale: "pt-BR" });
  });

  it("caller-supplied timezone / locale always win over the browser defaults", async () => {
    stubDevice("Europe/Berlin", "de-DE");
    const w = makeClient();
    w.identify("u1", { traits: { timezone: "America/New_York", locale: "en-GB", plan: "pro" } });
    const body = await identifyBody(w);
    expect(body.traits).toEqual({ timezone: "America/New_York", locale: "en-GB", plan: "pro" });
  });

  it("a legacy time_zone / tz alias counts as caller-supplied (no competing timezone default)", async () => {
    stubDevice("Europe/Berlin", "de-DE");
    const w = makeClient();
    w.identify("u1", { traits: { tz: "Asia/Tokyo" } });
    const body = await identifyBody(w);
    expect(body.traits).toEqual({ tz: "Asia/Tokyo", locale: "de-DE" });
  });

  it("sends no traits at all when the browser provides nothing and the caller passes none", async () => {
    stubDevice(undefined, "");
    const w = makeClient();
    w.identify("u1");
    const body = await identifyBody(w);
    expect(body).toEqual({ external_user_id: "u1", anonymous_id: expect.stringMatching(UUID_V4) });
  });

  it("omits only the key the browser cannot provide", async () => {
    stubDevice(undefined, "fr-CA");
    const w = makeClient();
    w.identify("u1", { traits: { plan: "pro" } });
    const body = await identifyBody(w);
    expect(body.traits).toEqual({ plan: "pro", locale: "fr-CA" });
  });

  it("leaves the per-event context locale untouched", async () => {
    stubDevice("Europe/Berlin", "de-DE");
    const w = makeClient();
    w.identify("u1");
    w.track("feature_used");
    await w.flush();
    const batch = captured.find((c) => c.path === "/v1/events/batch")!;
    expect(batch.body.events[0].context.locale).toBe("de-DE");
    expect(batch.body.events[0].context.timezone).toBeUndefined();
  });
});

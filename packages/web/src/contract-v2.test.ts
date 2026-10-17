import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhisperrClient } from "./client.js";
import type { WhisperrOptions } from "./types.js";

// Contract v2 (whisperr-spec): restore identify at start (C1), app_language
// (C2, C3 anonymous identify), version keys in every event context (C5).

// Fixed device traits so identify bodies are exact.
vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  deviceTraits: () => ({ timezone: "Europe/Berlin", locale: "de-DE" }),
}));
const DEVICE = { timezone: "Europe/Berlin", locale: "de-DE" };

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

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY = 24 * 60 * 60 * 1000;
const RESTORE_DELAY = 2000;
const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as { version: string };

interface Captured {
  path: string;
  body: any;
  keepalive?: boolean;
}
let captured: Captured[];
let status: number;
let offline: boolean;
let clients: WhisperrClient[];

beforeEach(() => {
  captured = [];
  status = 200;
  offline = false;
  clients = [];
  testLS.clear();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      if (offline) throw new TypeError("Failed to fetch");
      captured.push({ path: url.replace("https://api.whisperr.net", ""), body: JSON.parse(init.body), keepalive: init.keepalive });
      return { ok: status >= 200 && status < 300, status } as Response;
    }),
  );
});

afterEach(() => {
  // Listeners live on the shared jsdom window; mute finished clients.
  for (const c of clients) c.optOut();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function makeClient(extra: Partial<WhisperrOptions> = {}): WhisperrClient {
  const w = new WhisperrClient({
    apiKey: "wrk_test",
    flushIntervalMs: 1e9,
    autocapturePageviews: false,
        automaticEvents: false, // signals v3 events are covered in signals.test.ts
    maxRetries: 0,
    ...extra,
  });
  clients.push(w);
  return w;
}

const identifies = () => captured.filter((c) => c.path === "/v1/identify").map((c) => c.body);
const events = () => captured.filter((c) => c.path === "/v1/events/batch").flatMap((c) => c.body.events);
const queued = (): any[] => JSON.parse(testLS.getItem("whisperr.queue.v1") ?? "[]");

/** A previous page load that identified `user` (or ran `setup`) and delivered it; returns its anonymous id. */
async function previousSession(user: string, setup: (w: WhisperrClient) => void = (w) => w.identify(user)): Promise<string> {
  const w = makeClient();
  setup(w);
  await w.flush();
  const anon = identifies().at(-1)!.anonymous_id as string;
  w.optOut();
  testLS.removeItem("whisperr.optout");
  captured = [];
  return anon;
}

/** Starts a new page load and lets the restore-identify debounce run out. */
async function startAndWait(extra: Partial<WhisperrOptions> = {}): Promise<WhisperrClient> {
  const w = makeClient(extra);
  await vi.advanceTimersByTimeAsync(RESTORE_DELAY);
  await w.flush();
  return w;
}

describe("C1: restore identify at start", () => {
  it("queues one identify for the stored user: user, anonymous id, device traits, no channels", async () => {
    const anon = await previousSession("u1", (w) => w.identify("u1", { email: "a@b.c" }));
    vi.setSystemTime(Date.now() + DAY + 1); // past the 24h throttle
    await startAndWait();
    expect(identifies()).toEqual([{ external_user_id: "u1", anonymous_id: anon, traits: DEVICE }]);
  });

  it("sends nothing at start when there is no stored user", async () => {
    const w = await startAndWait();
    w.track("app_opened");
    await w.flush();
    expect(identifies()).toEqual([]);
  });

  it("is skipped when the app identifies the same user first", async () => {
    await previousSession("u1");
    vi.setSystemTime(Date.now() + DAY + 1);
    const w = makeClient();
    w.identify("u1", { traits: { plan: "pro" } });
    await vi.advanceTimersByTimeAsync(RESTORE_DELAY * 5);
    await w.flush();
    expect(identifies()).toEqual([{ external_user_id: "u1", anonymous_id: expect.any(String), traits: { ...DEVICE, plan: "pro" } }]);
  });

  it("is skipped when the same identify was delivered less than 24h ago, and sent again after", async () => {
    await previousSession("u1");
    vi.setSystemTime(Date.now() + DAY - 60_000);
    await startAndWait();
    expect(identifies()).toEqual([]);

    vi.setSystemTime(Date.now() + 120_000);
    await startAndWait();
    expect(identifies()).toHaveLength(1);
    expect(identifies()[0].external_user_id).toBe("u1");
  });

  it("counts the app's own identify (with any custom traits) for the 24h throttle", async () => {
    await previousSession("u1", (w) => w.identify("u1", { email: "a@b.c", traits: { plan: "pro" } }));
    await startAndWait();
    expect(identifies()).toEqual([]);
  });

  it("a delivered setAppLanguage updates the receipt, so the next start within 24h sends nothing", async () => {
    await previousSession("u1", (w) => {
      w.identify("u1");
      w.setAppLanguage("de");
    });
    vi.setSystemTime(Date.now() + 60_000);
    await startAndWait();
    expect(identifies()).toEqual([]);
  });

  it("is not throttled when the traits changed since the last delivered identify", async () => {
    await previousSession("u1");
    testLS.setItem("whisperr.app_language", "fr"); // stored language changed since then
    await startAndWait();
    expect(identifies()).toEqual([{ external_user_id: "u1", anonymous_id: expect.any(String), traits: { ...DEVICE, app_language: "fr" } }]);
  });

  it("records no receipt for a failed delivery, so the next start tries again", async () => {
    await previousSession("u1");
    vi.setSystemTime(Date.now() + DAY + 1);
    status = 400; // dropped
    await startAndWait();
    expect(identifies()).toHaveLength(1);

    status = 200;
    captured = [];
    await startAndWait();
    expect(identifies()).toHaveLength(1);
  });

  it("goes through the ordered persisted queue and waits there while offline", async () => {
    await previousSession("u1");
    vi.setSystemTime(Date.now() + DAY + 1);
    offline = true;
    const w = makeClient();
    w.track("before_restore");
    await vi.advanceTimersByTimeAsync(RESTORE_DELAY);
    expect(queued().map((op) => op.kind)).toEqual(["track", "identify"]);

    offline = false;
    await w.flush();
    expect(captured.map((c) => c.path)).toEqual(["/v1/events/batch", "/v1/identify"]);
    expect(queued()).toEqual([]);
  });

  it("is queued at most once per start", async () => {
    await previousSession("u1");
    vi.setSystemTime(Date.now() + DAY + 1);
    const w = await startAndWait();
    testLS.removeItem("whisperr.identify_receipt");
    await vi.advanceTimersByTimeAsync(DAY);
    await w.flush();
    expect(identifies()).toHaveLength(1);
  });

  it("two tabs starting together send one restore identify", async () => {
    await previousSession("u1");
    vi.setSystemTime(Date.now() + DAY + 1);
    offline = true; // no delivery (no receipt) before the second tab's timer fires
    const a = makeClient();
    const b = makeClient();
    await vi.advanceTimersByTimeAsync(RESTORE_DELAY);
    offline = false;
    await a.flush();
    await b.flush();
    expect(identifies()).toHaveLength(1);
  });

  it("is queued at once and sent with keepalive when the page hides before the debounce ends", async () => {
    await previousSession("u1");
    vi.setSystemTime(Date.now() + DAY + 1);
    makeClient();
    await vi.advanceTimersByTimeAsync(0); // startup drain
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    const call = captured.find((c) => c.path === "/v1/identify")!;
    expect(call.keepalive).toBe(true);
    expect(call.body.external_user_id).toBe("u1");
  });

  it("is not sent after reset(), after optOut(), or for an opted-out visitor", async () => {
    await previousSession("u1");
    vi.setSystemTime(Date.now() + DAY + 1);
    const a = makeClient();
    a.reset();
    await vi.advanceTimersByTimeAsync(RESTORE_DELAY);
    await a.flush();
    expect(identifies()).toEqual([]);

    await previousSession("u2");
    vi.setSystemTime(Date.now() + DAY + 1);
    const b = makeClient();
    b.optOut();
    await vi.advanceTimersByTimeAsync(RESTORE_DELAY);
    makeClient(); // opted out at construction
    await vi.advanceTimersByTimeAsync(RESTORE_DELAY);
    expect(identifies()).toEqual([]);
  });
});

describe("C2: setAppLanguage", () => {
  it("with a user: queues a partial identify {external_user_id, traits: {app_language}}", async () => {
    const w = makeClient();
    w.identify("u1");
    await w.flush();
    captured = [];
    w.setAppLanguage("de");
    await w.flush();
    expect(identifies()).toEqual([{ external_user_id: "u1", traits: { app_language: "de" } }]);
  });

  it("without a user: queues an anonymous identify {anonymous_id, traits: {app_language}}", async () => {
    const w = makeClient();
    w.track("app_opened");
    await w.flush();
    const anon = events()[0].anonymous_id;
    w.setAppLanguage("pt-BR");
    await w.flush();
    expect(identifies()).toEqual([{ anonymous_id: anon, traits: { app_language: "pt-BR" } }]);
    expect(anon).toMatch(UUID_V4);
  });

  it("an anonymous identify stays anonymous when identify() follows before delivery", async () => {
    offline = true;
    const w = makeClient();
    w.setAppLanguage("de");
    w.identify("u1");
    offline = false;
    await w.flush();
    const [anonymous, identify] = identifies();
    expect(anonymous).toEqual({ anonymous_id: expect.stringMatching(UUID_V4), traits: { app_language: "de" } });
    expect(identify).toEqual({
      external_user_id: "u1",
      anonymous_id: anonymous.anonymous_id,
      traits: { ...DEVICE, app_language: "de" },
    });
  });

  it('changes "_" to "-"', async () => {
    const w = makeClient();
    w.setAppLanguage("pt_BR");
    await w.flush();
    expect(identifies()[0].traits).toEqual({ app_language: "pt-BR" });
  });

  it("ignores an invalid tag with a debug log, and keeps the stored value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = makeClient({ debug: true });
    w.setAppLanguage("de");
    await w.flush();
    captured = [];
    for (const bad of ["", "  ", "not a tag", "e", "de--DE", "123", "toolongprimary"]) w.setAppLanguage(bad);
    w.setAppLanguage(42 as unknown as string);
    await w.flush();
    expect(identifies()).toEqual([]);
    expect(testLS.getItem("whisperr.app_language")).toBe("de");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a BCP 47 language tag"));
    warn.mockRestore();
  });

  it("is persisted: a later page load's identify carries it", async () => {
    const a = makeClient();
    a.setAppLanguage("de");
    await a.flush();
    captured = [];
    const b = makeClient();
    b.identify("u1", { traits: { plan: "pro" } });
    await b.flush();
    expect(identifies()[0].traits).toEqual({ ...DEVICE, plan: "pro", app_language: "de" });
  });

  it("a caller-supplied traits.app_language wins", async () => {
    const w = makeClient();
    w.setAppLanguage("de");
    w.identify("u1", { traits: { app_language: "it" } });
    await w.flush();
    expect(identifies().at(-1)!.traits).toEqual({ ...DEVICE, app_language: "it" });
  });

  it("the restore identify carries it", async () => {
    await previousSession("u1", (w) => {
      w.setAppLanguage("es");
      w.identify("u1");
    });
    vi.setSystemTime(Date.now() + DAY + 1);
    await startAndWait();
    expect(identifies()).toEqual([{ external_user_id: "u1", anonymous_id: expect.any(String), traits: { ...DEVICE, app_language: "es" } }]);
  });

  it("null clears the stored value and sends nothing", async () => {
    const w = makeClient();
    w.identify("u1");
    w.setAppLanguage("de");
    await w.flush();
    captured = [];
    w.setAppLanguage(null);
    await w.flush();
    expect(identifies()).toEqual([]);
    expect(testLS.getItem("whisperr.app_language")).toBeNull();
    w.identify("u1");
    await w.flush();
    expect(identifies()[0].traits).toEqual(DEVICE);
  });

  it("an unchanged value sends nothing (apps may set it on every page load)", async () => {
    const a = makeClient();
    a.identify("u1");
    a.setAppLanguage("de");
    await a.flush();
    captured = [];
    a.setAppLanguage("de");
    const b = makeClient();
    b.setAppLanguage("de");
    await a.flush();
    await b.flush();
    expect(identifies()).toEqual([]);
  });

  it("is stored but not sent while opted out", async () => {
    const w = makeClient();
    w.optOut();
    w.setAppLanguage("de");
    await w.flush();
    expect(captured).toEqual([]);
    expect(testLS.getItem("whisperr.app_language")).toBe("de");
  });

  it("never throws when localStorage is unusable", async () => {
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    Object.defineProperty(window, "localStorage", { value: throwing, configurable: true });
    try {
      const w = makeClient();
      expect(() => w.setAppLanguage("de")).not.toThrow();
      expect(() => w.setAppLanguage(null)).not.toThrow();
      await w.flush();
    } finally {
      Object.defineProperty(window, "localStorage", { value: testLS, configurable: true });
    }
  });
});

describe("C5: version keys in every event context", () => {
  it("carries platform, sdk_name, sdk_version (= package version) and the configured app version/build", async () => {
    const w = makeClient({ appVersion: "2.4.0", appBuild: "512" });
    w.track("feature_used", { a: 1 });
    w.page("Home");
    await w.flush();
    for (const ev of events()) {
      expect(ev.context).toMatchObject({
        platform: "web",
        sdk_name: "whisperr-web",
        sdk_version: pkg.version,
        app_version: "2.4.0",
        app_build: "512",
      });
      expect(ev.context).not.toHaveProperty("locale");
    }
    expect(events().map((e) => e.event_type)).toEqual(["feature_used", "page_viewed"]);
  });

  it("no value, no key: app_version / app_build are absent when not configured or empty", async () => {
    const a = makeClient();
    a.track("a_event");
    await a.flush();
    const b = makeClient({ appVersion: " ", appBuild: "" });
    b.track("b_event");
    await b.flush();
    expect(events()).toHaveLength(2);
    for (const ev of events()) {
      expect(ev.context).not.toHaveProperty("app_version");
      expect(ev.context).not.toHaveProperty("app_build");
      expect(ev.context.platform).toBe("web");
    }
  });

  it("automatic pageviews carry the keys too", async () => {
    const w = makeClient({ autocapturePageviews: true, appVersion: "1.0.0" });
    await w.flush();
    const pv = events().find((e) => e.event_type === "page_viewed")!;
    expect(pv.context).toMatchObject({ platform: "web", sdk_name: "whisperr-web", app_version: "1.0.0" });
  });
});

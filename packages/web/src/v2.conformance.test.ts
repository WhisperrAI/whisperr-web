// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhisperrClient } from "./client.js";
import { SDK_NAME, SDK_VERSION } from "./runtime.js";

// whisperr-spec conformance/v2.json: the contract v2 sections that apply to
// web (restore identify, app_language, version context). Environment
// detection is ON only in a case with a `device` block and reads only its
// values; without one, device traits and version context keys are OFF.
interface Device {
  locale?: string;
  timezone?: string;
  appVersion?: string;
  appBuild?: string;
}
let device: Device | null = null;

vi.mock("./runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime.js")>();
  return {
    ...actual,
    deviceTraits: () => {
      const out: Record<string, string> = {};
      if (device?.timezone) out.timezone = device.timezone;
      if (device?.locale) out.locale = device.locale;
      return out;
    },
    environmentContext: () =>
      device ? actual.environmentContext({ appVersion: device.appVersion, appBuild: device.appBuild }) : {},
  };
});

const WEB_SECTIONS = ["restoreIdentify", "appLanguage", "versionContext"];
const SPEC_URL = "https://raw.githubusercontent.com/WhisperrAI/whisperr-spec/main/conformance/v2.json";
// The SDK waits this long at start before it queues the restore identify; a
// `restart` step lets it run out (the object form identifies before it does).
const RESTORE_DELAY_MS = 2000;
const GOVERNED_CONTEXT_KEYS = ["app_version", "app_build", "platform", "sdk_name", "sdk_version", "locale"];

type Step =
  | { identify: { externalUserId: string; traits?: Record<string, unknown>; pushToken?: string } }
  | { track: { eventType: string; properties?: Record<string, unknown> } }
  | { setAppLanguage: string | null }
  | { restart: true | { thenIdentify: { externalUserId: string; traits?: Record<string, unknown> } } }
  | { reset: true }
  | { optOut: true }
  | { optIn: true }
  | { advanceClock: { hours?: number; minutes?: number; seconds?: number } }
  | { setDevice: Device };

type ExpectedRequest =
  | { endpoint: "/v1/events/batch"; events: Record<string, unknown>[] }
  | { endpoint: "/v1/identify"; body: Record<string, unknown> };

interface V2Case {
  name: string;
  device?: Device;
  steps: Step[];
  expectedRequests: ExpectedRequest[];
}
interface V2Section {
  appliesTo: string[];
  cases: V2Case[];
}

async function loadSpec(): Promise<{ sections: Record<string, V2Section> } | null> {
  const wire = process.env.WHISPERR_SPEC_PATH;
  const local = process.env.WHISPERR_V2_SPEC_PATH ?? (wire ? join(dirname(wire), "v2.json") : undefined);
  if (local) return existsSync(local) ? JSON.parse(readFileSync(local, "utf8")) : null;
  const res = await fetch(SPEC_URL);
  return res.ok ? res.json() : null;
}

const spec = await loadSpec();
// CI sets this once it checks out a spec ref that has v2.json, so a missing
// file fails instead of skipping.
const required = process.env.WHISPERR_REQUIRE_V2 === "1";

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

let captured: { path: string; body: any }[] = [];

beforeEach(() => {
  captured = [];
  testLS.clear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: any) => {
      captured.push({ path: url.replace("https://api.whisperr.net", ""), body: JSON.parse(init.body) });
      return { ok: true, status: 200 } as Response;
    }),
  );
});

afterEach(() => {
  device = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function makeClient(): WhisperrClient {
  return new WhisperrClient({ apiKey: "wrk_test", flushIntervalMs: 1e9, autocapturePageviews: false });
}

async function run(c: V2Case): Promise<void> {
  device = c.device ? { ...c.device } : null;
  let w = makeClient();
  await w.flush();
  for (const step of c.steps) {
    if ("identify" in step) {
      w.identify(step.identify.externalUserId, { traits: step.identify.traits, pushToken: step.identify.pushToken });
    } else if ("track" in step) w.track(step.track.eventType, step.track.properties);
    else if ("setAppLanguage" in step) w.setAppLanguage(step.setAppLanguage);
    else if ("restart" in step) {
      w = makeClient();
      if (step.restart !== true) w.identify(step.restart.thenIdentify.externalUserId, { traits: step.restart.thenIdentify.traits });
      await vi.advanceTimersByTimeAsync(RESTORE_DELAY_MS);
    } else if ("reset" in step) w.reset();
    else if ("optOut" in step) w.optOut();
    else if ("optIn" in step) w.optIn();
    else if ("advanceClock" in step) {
      const { hours = 0, minutes = 0, seconds = 0 } = step.advanceClock;
      vi.setSystemTime(Date.now() + ((hours * 60 + minutes) * 60 + seconds) * 1000);
    } else if ("setDevice" in step) device = { ...(device ?? {}), ...step.setDevice };
    else throw new Error(`${c.name}: unknown step ${JSON.stringify(step)}`);
    await w.flush();
  }
}

function check(c: V2Case): void {
  const handles = new Map<string, string>();
  const resolve = (expected: unknown, actual: unknown, where: string): unknown => {
    if (expected === "$platform") return "web";
    if (expected === "$sdk_name") return SDK_NAME;
    if (expected === "$sdk_version") return SDK_VERSION;
    if (typeof expected !== "string" || !expected.startsWith("$anon_")) return expected;
    expect(typeof actual, where).toBe("string");
    if (!handles.has(expected)) {
      expect([...handles.values()], `${where}: distinct placeholders`).not.toContain(actual);
      handles.set(expected, actual as string);
    }
    return handles.get(expected);
  };
  const substitute = (expected: Record<string, unknown>, actual: Record<string, unknown> | undefined, where: string) =>
    Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, resolve(v, actual?.[k], `${where}.${k}`)]));

  expect(captured.map((r) => r.path), c.name).toEqual(c.expectedRequests.map((r) => r.endpoint));
  c.expectedRequests.forEach((r, i) => {
    const where = `${c.name}[${i}]`;
    const actual = captured[i]!.body;
    if ("body" in r) {
      const body = { ...actual };
      // An identified body may carry the anonymous handle when the case does not name it.
      if (body.external_user_id && !("anonymous_id" in r.body)) delete body.anonymous_id;
      expect(body, where).toEqual(substitute(r.body, body, where));
      return;
    }
    expect(actual.events.length, where).toBe(r.events.length);
    r.events.forEach((expected, j) => {
      const at = `${where}.events[${j}]`;
      const { occurred_at, context, ...rest } = actual.events[j];
      expect(occurred_at, `${at} occurred_at`).toBeTruthy();
      expect(context?.$message_id, `${at} context.$message_id`).toBeTruthy();
      const { context: expectedContext, ...expectedRest } = expected as { context?: Record<string, unknown> };
      expect(rest, at).toEqual(substitute(expectedRest, rest, at));
      if (!expectedContext) return;
      const want = substitute(expectedContext, context, `${at}.context`);
      for (const key of GOVERNED_CONTEXT_KEYS) {
        if (key in want) expect(context[key], `${at}.context.${key}`).toEqual(want[key]);
        else expect(context, `${at}.context`).not.toHaveProperty(key);
      }
    });
  });
}

describe("contract v2 conformance (whisperr-spec conformance/v2.json)", () => {
  if (!spec) {
    it.skipIf(!required)("v2.json is not in the checked-out spec yet", () => {
      throw new Error("WHISPERR_REQUIRE_V2=1 but conformance/v2.json was not found");
    });
    return;
  }
  for (const name of WEB_SECTIONS) {
    const section = spec.sections[name];
    it(`${name}: section exists and applies to web`, () => {
      expect(section, name).toBeTruthy();
      expect(section!.appliesTo).toContain("web");
    });
    for (const c of section?.cases ?? []) {
      it(`${name}: ${c.name}`, async () => {
        await run(c);
        check(c);
      });
    }
  }
});

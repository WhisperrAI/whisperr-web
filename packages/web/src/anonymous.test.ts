// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhisperrClient } from "./client.js";

// Device-derived trait defaults (timezone / locale) are environment-dependent
// and the fixture pins identify bodies exactly, so the harness runs with them
// disabled — the same way conformance.test.ts does for wire.json.
vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  deviceTraits: () => ({}),
}));

const SPEC_URL =
  "https://raw.githubusercontent.com/WhisperrAI/whisperr-spec/main/conformance/anonymous.json";

// Real fetch captured before we stub the global for request capture.
const realFetch = globalThis.fetch.bind(globalThis);

type Step =
  | { track: { eventType: string; properties?: Record<string, unknown> } }
  | { identify: { externalUserId: string; traits?: Record<string, unknown> } }
  | { reset: true };

type ExpectedRequest =
  | { endpoint: "/v1/events/batch"; events: Record<string, unknown>[] }
  | { endpoint: "/v1/identify"; body: Record<string, unknown> };

interface AnonymousCase {
  name: string;
  steps: Step[];
  expectedRequests: ExpectedRequest[];
}

// The fixture as of whisperr-spec PR #6, carried here so this suite runs
// against a spec checkout that predates it. The spec's copy wins once present.
const VENDORED_SPEC = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "anonymous.json");

async function loadSpec(): Promise<{ cases: AnonymousCase[] }> {
  // anonymous.json lives next to wire.json; derive it like behavior.test.ts does.
  const wire = process.env.WHISPERR_SPEC_PATH;
  const local =
    process.env.WHISPERR_ANONYMOUS_SPEC_PATH ?? (wire ? join(dirname(wire), "anonymous.json") : undefined);
  if (local && existsSync(local)) return JSON.parse(readFileSync(local, "utf8"));
  if (!local) {
    const res = await realFetch(SPEC_URL);
    if (res.ok) return res.json();
  }
  return JSON.parse(readFileSync(VENDORED_SPEC, "utf8"));
}

afterEach(() => vi.unstubAllGlobals());

describe("anonymous-identity conformance (whisperr-spec)", () => {
  it("sends pre-identify events under anonymous_id, promotes on identify(), rotates on reset()", async () => {
    const spec = await loadSpec();
    expect(spec.cases.length).toBeGreaterThan(0);

    for (const c of spec.cases) {
      const captured: { path: string; body: any }[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: any) => {
          captured.push({ path: url.replace("https://api.whisperr.net", ""), body: JSON.parse(init.body) });
          return { ok: true, status: 200 } as Response;
        }),
      );

      const w = new WhisperrClient({
        apiKey: "wrk_test",
        flushIntervalMs: 1e9,
        autocapturePageviews: false,
        persistence: "memory",
      });
      for (const step of c.steps) {
        if ("track" in step) w.track(step.track.eventType, step.track.properties);
        else if ("identify" in step) w.identify(step.identify.externalUserId, { traits: step.identify.traits });
        else w.reset();
        await w.flush();
      }

      // `$anon_*` values are placeholders: each binds to the first handle seen
      // for it and must match from then on; distinct placeholders, distinct handles.
      const handles = new Map<string, string>();
      const resolve = (expected: unknown, actual: unknown, where: string): unknown => {
        if (typeof expected !== "string" || !expected.startsWith("$anon_")) return expected;
        expect(typeof actual, where).toBe("string");
        const handle = actual as string;
        expect(handle.length, where).toBeGreaterThanOrEqual(1);
        expect(handle.length, where).toBeLessThanOrEqual(128);
        if (!handles.has(expected)) {
          expect([...handles.values()], `${where}: distinct placeholders`).not.toContain(handle);
          handles.set(expected, handle);
        }
        return handles.get(expected);
      };
      const substitute = (expected: Record<string, unknown>, actual: Record<string, unknown> | undefined, where: string) =>
        Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, resolve(v, actual?.[k], `${where}.${k}`)]));

      expect(captured.map((r) => r.path), c.name).toEqual(c.expectedRequests.map((r) => r.endpoint));
      c.expectedRequests.forEach((r, i) => {
        const where = `${c.name}[${i}]`;
        const actual = captured[i]!.body;
        if ("events" in r) {
          // occurred_at and context are volatile; context must still carry $message_id.
          const events = actual.events.map(({ occurred_at, context, ...rest }: any) => {
            expect(occurred_at, `${where} occurred_at`).toBeTruthy();
            expect(context?.$message_id, `${where} context.$message_id`).toBeTruthy();
            return rest;
          });
          expect(events, where).toEqual(r.events.map((e, j) => substitute(e, events[j], `${where}.events[${j}]`)));
        } else {
          expect(actual, where).toEqual(substitute(r.body, actual, where));
        }
      });
    }
  }, 20000);
});

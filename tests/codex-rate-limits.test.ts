import { describe, expect, it } from "vitest";
import {
  parseRateLimitsNotification,
  parseRateLimitsResponse,
} from "../src/main/codex/rate-limits";

const window = (
  usedPercent = 25,
  windowDurationMins: number | null = 300,
  resetsAt: number | null = 1_800_000_000,
) => ({ usedPercent, windowDurationMins, resetsAt });
const bucket = (
  limitId: string | null = "codex",
  primary: unknown = window(),
  secondary: unknown = window(50, 10080),
) => ({ limitId, primary, secondary });
const response = (
  rateLimits: unknown = bucket(),
  rateLimitsByLimitId: unknown = null,
) => ({ rateLimits, rateLimitsByLimitId });

describe("rate limit domain boundary", () => {
  it("identifies windows by duration and computes remaining quota", () => {
    const result = parseRateLimitsResponse(
      response(bucket("codex", window(100, 10080), window(0, 300))),
    );
    expect(result.defaultSelection).toEqual({
      state: "selected",
      bucketId: "codex",
    });
    expect(result.buckets[0]?.fiveHour).toMatchObject({
      state: "available",
      window: {
        remainingPercent: 100,
        usedPercent: 0,
        resetsAtMs: 1_800_000_000_000,
      },
    });
    expect(result.buckets[0]?.weekly).toMatchObject({
      state: "available",
      window: { remainingPercent: 0 },
    });
  });

  it("represents missing and future window types", () => {
    const result = parseRateLimitsResponse(
      response(bucket(null, window(10, 60, null), null)),
    );
    expect(result.defaultSelection).toEqual({
      state: "selected",
      bucketId: "legacy",
    });
    expect(result.buckets[0]).toMatchObject({
      source: "legacy",
      fiveHour: { state: "missing" },
      weekly: { state: "missing" },
      windows: [{ kind: "unknown", durationMinutes: 60, resetsAtMs: null }],
    });
    expect(
      parseRateLimitsResponse(response(bucket(null, window(0, null), null)))
        .buckets[0]?.windows[0]?.kind,
    ).toBe("unknown");
  });

  it("keeps independent buckets with identical durations and selects only codex", () => {
    const result = parseRateLimitsResponse(
      response(bucket(), {
        other: bucket("other", window(90)),
        codex: bucket("codex", window(20)),
      }),
    );
    expect(result.buckets.map(({ bucketId }) => bucketId)).toEqual([
      "codex",
      "other",
    ]);
    expect(
      result.buckets.map(({ windows }) => windows[0]?.remainingPercent),
    ).toEqual([80, 10]);
    expect(result.defaultSelection).toEqual({
      state: "selected",
      bucketId: "codex",
    });
  });

  it("reports ambiguity for maps without a verified default bucket", () => {
    expect(
      parseRateLimitsResponse(response(bucket(), { other: bucket("other") }))
        .defaultSelection,
    ).toEqual({ state: "ambiguous" });
    expect(
      parseRateLimitsResponse(response(bucket(), {})).defaultSelection,
    ).toEqual({ state: "missing" });
    expect(
      parseRateLimitsResponse(response(bucket("other"))).defaultSelection,
    ).toEqual({ state: "ambiguous" });
  });

  it("uses the map identity when the embedded ID is null", () => {
    expect(
      parseRateLimitsResponse(response(bucket(), { codex: bucket(null) }))
        .buckets[0]?.bucketId,
    ).toBe("codex");
  });

  it("reports duplicate windows within one bucket without overwriting", () => {
    const result = parseRateLimitsResponse(
      response(bucket("codex", window(20), window(30))),
    );
    expect(result.buckets[0]?.fiveHour).toEqual({ state: "ambiguous" });
    expect(result.buckets[0]?.windows).toHaveLength(2);
    expect(
      parseRateLimitsResponse(
        response(bucket("codex", window(20, 10080), window(20, 10080))),
      ).buckets[0]?.weekly.state,
    ).toBe("ambiguous");
  });

  it.each([NaN, Infinity, -1, 101, "25", null])(
    "rejects invalid percentage %s",
    (value) => {
      expect(() =>
        parseRateLimitsResponse(
          response(bucket("codex", { ...window(), usedPercent: value })),
        ),
      ).toThrow("Invalid rate limit data");
    },
  );

  it.each([NaN, Infinity, -1, 1.5, 1_800_000_000_000, "1800000000", undefined])(
    "rejects invalid reset seconds %s",
    (resetsAt) => {
      expect(() =>
        parseRateLimitsResponse(
          response(bucket("codex", { ...window(), resetsAt })),
        ),
      ).toThrow();
    },
  );

  it("accepts epoch reset and explicit unavailable reset", () => {
    expect(
      parseRateLimitsResponse(response(bucket("codex", window(0, 300, 0))))
        .buckets[0]?.windows[0]?.resetsAtMs,
    ).toBe(0);
    expect(
      parseRateLimitsResponse(response(bucket("codex", window(0, 300, null))))
        .buckets[0]?.windows[0]?.resetsAtMs,
    ).toBeNull();
  });

  it.each([
    undefined,
    null,
    [],
    {},
    response(null),
    response({ primary: null, secondary: null }),
    response(bucket(), []),
    response(bucket(), { codex: bucket("other") }),
    response(bucket(), { "": bucket(null) }),
    response(bucket("")),
    response(bucket("codex", { ...window(), windowDurationMins: 0 })),
    response(bucket("codex", { ...window(), windowDurationMins: 0.5 })),
    response(bucket("codex", { ...window(), windowDurationMins: "300" })),
    response(
      bucket(),
      Object.fromEntries(
        Array.from({ length: 65 }, (_, i) => [String(i), bucket(String(i))]),
      ),
    ),
  ])("rejects malformed response %#", (value) => {
    expect(() => parseRateLimitsResponse(value)).toThrow(
      "Invalid rate limit data",
    );
  });

  it("parses sparse notifications without manufacturing a missing window", () => {
    const result = parseRateLimitsNotification({
      rateLimits: {
        limitId: "codex",
        primary: window(31),
        limitName: "Synthetic quota",
      },
    });
    expect(result).toMatchObject({
      bucketId: "codex",
      source: "notification",
      weekly: { state: "missing" },
      windows: [{ usedPercent: 31, remainingPercent: 69 }],
    });
    expect(
      parseRateLimitsNotification({ rateLimits: { secondary: null } }).bucketId,
    ).toBe("unidentified");
    expect(() =>
      parseRateLimitsNotification({
        rateLimits: { primary: { usedPercent: 31 } },
      }),
    ).toThrow();
    expect(() => parseRateLimitsNotification(null)).toThrow();
    expect(() => parseRateLimitsNotification({ rateLimits: {} })).toThrow();
  });

  it("discards account and credit metadata from the internal model", () => {
    const result = parseRateLimitsResponse({
      ...response({ ...bucket(), credits: { balance: "synthetic" } }),
      accountId: "fixture",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /accountId|credits|fixture|balance/,
    );
  });
});

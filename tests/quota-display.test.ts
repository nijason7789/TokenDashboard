import { expect, it } from "vitest";
import { parseRateLimitsResponse } from "../src/main/codex/rate-limits";
import { quotaDisplayStatus } from "../src/main/services/quota-display";

const legacy = {
  limitId: "codex",
  primary: { windowDurationMins: 300, resetsAt: 1800000000, usedPercent: 55 },
  secondary: null,
};

it("maps only the selected bucket without borrowing a weekly window", () => {
  const extra = {
    limitId: "extra",
    primary: { windowDurationMins: 10080, resetsAt: null, usedPercent: 99 },
    secondary: null,
  };
  const snapshot = parseRateLimitsResponse({
    rateLimits: legacy,
    rateLimitsByLimitId: { codex: legacy, extra },
  });
  expect(
    quotaDisplayStatus(
      { phase: "stale", reason: "timeout", snapshot, updatedAtMs: 123 },
      "mock",
    ),
  ).toEqual({
    source: "mock",
    phase: "stale",
    updatedAtMs: 123,
    fiveHour: {
      state: "available",
      remainingPercent: 45,
      resetsAtMs: 1800000000000,
    },
    weekly: { state: "missing" },
  });
});

it.each(["ambiguous", "missing"] as const)(
  "preserves %s default selection",
  (state) => {
    expect(
      quotaDisplayStatus({
        phase: "connected",
        snapshot: { buckets: [], defaultSelection: { state } },
        updatedAtMs: 0,
      }),
    ).toEqual({
      source: "monitor",
      phase: "connected",
      updatedAtMs: 0,
      fiveHour: { state },
      weekly: { state },
    });
  },
);

it("maps unavailable and redacts error details", () => {
  expect(quotaDisplayStatus()).toEqual({ source: "unavailable" });
  expect(quotaDisplayStatus({ phase: "error", reason: "trust" })).toEqual({
    source: "monitor",
    phase: "error",
  });
  expect(quotaDisplayStatus({ phase: "connecting" })).toEqual({
    source: "monitor",
    phase: "connecting",
  });
});

it("treats a selected bucket absent from the snapshot as missing", () => {
  const snapshot = {
    buckets: [],
    defaultSelection: { state: "selected" as const, bucketId: "codex" },
  };
  expect(
    quotaDisplayStatus({ phase: "connected", snapshot, updatedAtMs: 0 }),
  ).toMatchObject({
    fiveHour: { state: "missing" },
    weekly: { state: "missing" },
  });
});

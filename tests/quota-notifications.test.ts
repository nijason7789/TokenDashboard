import { expect, it } from "vitest";
import {
  LowQuotaNotifications,
  type NotificationQuota,
} from "../src/main/quota-notifications";
import { DEFAULT_SETTINGS } from "../src/shared/settings";

const settings = {
  ...DEFAULT_SETTINGS,
  lowQuotaNotification: true,
  lowQuotaThreshold: 20,
};
const low: NotificationQuota = {
  source: "mock",
  phase: "connected",
  updatedAtMs: 0,
  bucketId: "codex",
  fiveHour: { state: "available", remainingPercent: 19, resetsAtMs: 5000 },
  weekly: { state: "available", remainingPercent: 20, resetsAtMs: 10000 },
};

it("notifies each selected quota interval once and re-arms after reset", () => {
  const policy = new LowQuotaNotifications();
  expect(policy.collect(low, settings, 0)).toEqual([
    "5-hour limit",
    "Weekly limit",
  ]);
  expect(policy.collect(low, settings, 1)).toEqual([]);
  expect(
    policy.collect(
      {
        ...low,
        fiveHour: {
          state: "available",
          remainingPercent: 50,
          resetsAtMs: 5000,
        },
      },
      settings,
      2,
    ),
  ).toEqual([]);
  expect(policy.collect(low, settings, 3)).toEqual([]);
  expect(
    policy.collect(
      {
        ...low,
        fiveHour: {
          state: "available",
          remainingPercent: 10,
          resetsAtMs: 15000,
        },
      },
      settings,
      5001,
    ),
  ).toEqual(["5-hour limit"]);
});

it("keeps distinct buckets separate even with equal reset dates", () => {
  const policy = new LowQuotaNotifications();
  policy.collect(low, settings, 0);
  expect(
    policy.collect({ ...low, bucketId: "other" }, settings, 0),
  ).toHaveLength(2);
  expect(policy.collect(low, settings, 1)).toEqual([]);
});

it("ignores disabled, stale, unavailable, ambiguous and unknown reset data", () => {
  const policy = new LowQuotaNotifications();
  expect(
    policy.collect(low, { ...settings, lowQuotaNotification: false }, 0),
  ).toEqual([]);
  expect(policy.collect({ ...low, phase: "stale" }, settings, 0)).toEqual([]);
  expect(policy.collect({ source: "unavailable" }, settings, 0)).toEqual([]);
  expect(policy.collect({ ...low, bucketId: undefined }, settings, 0)).toEqual(
    [],
  );
  expect(
    policy.collect(
      {
        ...low,
        fiveHour: { state: "ambiguous" },
        weekly: { state: "available", remainingPercent: 0, resetsAtMs: null },
      },
      settings,
      0,
    ),
  ).toEqual([]);
  expect(policy.collect(low, settings, 10001)).toEqual([]);
  expect(policy.collect(low, settings, 0)).toHaveLength(2);
});

it("rejects malformed values instead of sending misleading notifications", () => {
  const policy = new LowQuotaNotifications();
  const bad = {
    ...low,
    fiveHour: {
      state: "available" as const,
      remainingPercent: NaN,
      resetsAtMs: 5000,
    },
    weekly: { state: "missing" as const },
  };
  expect(policy.collect(bad, settings, 0)).toEqual([]);
  expect(
    policy.collect(low, { ...settings, lowQuotaThreshold: NaN }, 0),
  ).toEqual([]);
});

it("bounds remembered intervals and resumes after they expire", () => {
  const policy = new LowQuotaNotifications();
  for (let index = 0; index < 64; index++) {
    expect(
      policy.collect({ ...low, bucketId: "bucket-" + index }, settings, 0),
    ).toHaveLength(2);
  }
  expect(policy.collect(low, settings, 0)).toEqual([]);
  expect(
    policy.collect(
      {
        ...low,
        fiveHour: {
          state: "available",
          remainingPercent: 1,
          resetsAtMs: 20000,
        },
      },
      settings,
      10001,
    ),
  ).toEqual(["5-hour limit"]);
});

it("restores only bounded hashed interval state and suppresses notifications after restart", () => {
  const first = new LowQuotaNotifications();
  expect(first.collect(low, settings, 0)).toHaveLength(2);
  const state = first.snapshot();
  expect(JSON.stringify(state)).not.toContain("codex");
  expect(state[0]?.key).toMatch(/^[a-f0-9]{64}$/);
  const restarted = new LowQuotaNotifications(state);
  expect(restarted.collect(low, settings, 1)).toEqual([]);
  expect(
    new LowQuotaNotifications([
      { key: "account", resetsAtMs: 5000 },
    ]).snapshot(),
  ).toEqual([]);
  expect(
    new LowQuotaNotifications(Array(129).fill(state[0])).snapshot(),
  ).toEqual([]);
  expect(
    new LowQuotaNotifications([
      { key: state[0]!.key, resetsAtMs: NaN },
    ]).snapshot(),
  ).toEqual([]);
});

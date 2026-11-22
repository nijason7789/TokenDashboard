import { expect, it } from "vitest";
import { sanitizedStatus } from "../src/shared/contract";
import {
  DEFAULT_SETTINGS,
  isSettings,
  isSettingsPatch,
} from "../src/shared/settings";

it("validates every settings field and rejects payloads with private or unexpected keys", () => {
  expect(isSettings(DEFAULT_SETTINGS)).toBe(true);
  expect(isSettingsPatch({ refreshInterval: 120, opacity: 0.65 })).toBe(true);
  for (const payload of [
    null,
    [],
    new Date(),
    { launchOnStartup: 1 },
    { refreshInterval: 45 },
    { opacity: NaN },
    { opacity: 0.4 },
    { lowQuotaThreshold: 100 },
    { lowQuotaThreshold: 2.5 },
    { percentageMode: "other" },
    { command: "local" },
    JSON.parse('{"__proto__":{}}'),
  ]) {
    expect(isSettingsPatch(payload)).toBe(false);
  }
  expect(isSettings({ compact: true })).toBe(false);
});

it("accepts only display information and strips raw payload and bucket metadata", () => {
  expect(
    sanitizedStatus({
      source: "mock",
      phase: "connected",
      bucketId: "private",
      raw: { id: 1 },
      fiveHour: {
        state: "available",
        remainingPercent: 50,
        resetsAtMs: 101,
        token: "private",
      },
    }),
  ).toEqual({
    source: "mock",
    phase: "connected",
    fiveHour: { state: "available", remainingPercent: 50, resetsAtMs: 101 },
  });
  expect(
    sanitizedStatus({
      source: "unavailable",
      updatedAtMs: 0,
      weekly: { state: "missing" },
    }),
  ).toEqual({ source: "unavailable" });
  expect(
    sanitizedStatus({
      source: "mock",
      phase: "connected",
      weekly: { state: "available", remainingPercent: 101, resetsAtMs: null },
    }),
  ).toBeUndefined();
  expect(sanitizedStatus({ source: "external" })).toBeUndefined();
});

import type { QuotaStatus } from "../../src/shared/contract";

export const mockQuota = {
  source: "mock",
  phase: "connected",
  updatedAtMs: 1000,
  fiveHour: { state: "available", remainingPercent: 68, resetsAtMs: 9001000 },
  weekly: { state: "available", remainingPercent: 42, resetsAtMs: 270001000 },
} satisfies QuotaStatus;

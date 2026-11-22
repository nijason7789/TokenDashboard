import type { QuotaStatus } from "../../src/shared/contract";

export const mockQuota = {
  source: "mock",
  remaining: 68,
} satisfies QuotaStatus;

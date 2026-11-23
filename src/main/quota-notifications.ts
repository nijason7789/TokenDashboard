import type { QuotaStatus } from "../shared/contract";
import type { Settings } from "../shared/settings";
import { createHash } from "node:crypto";

export type NotificationState = { key: string; resetsAtMs: number }[];
export type NotificationQuota = QuotaStatus & { bucketId?: string };

export function notificationState(input: unknown): NotificationState {
  if (!Array.isArray(input) || input.length > 128) return [];
  const result: NotificationState = [];
  for (const entry of input) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.key !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.key) ||
      !Number.isSafeInteger(entry.resetsAtMs) ||
      entry.resetsAtMs <= 0 ||
      entry.resetsAtMs > 253402300799000
    )
      return [];
    result.push({ key: entry.key, resetsAtMs: entry.resetsAtMs });
  }
  return result;
}

export class LowQuotaNotifications {
  #sent = new Map<string, number>();
  #writes = Promise.resolve();

  constructor(initial?: unknown) {
    for (const { key, resetsAtMs } of notificationState(initial))
      this.#sent.set(key, resetsAtMs);
  }

  snapshot(): NotificationState {
    return [...this.#sent].map(([key, resetsAtMs]) => ({ key, resetsAtMs }));
  }

  persistAndCollect(
    status: NotificationQuota,
    settings: Settings,
    persist: (state: NotificationState) => Promise<void>,
    nowMs = Date.now(),
  ): Promise<string[]> {
    const write = this.#writes.then(async () => {
      const candidate = new LowQuotaNotifications(this.snapshot());
      const labels = candidate.collect(status, settings, nowMs);
      if (!labels.length) return labels;
      await persist(candidate.snapshot());
      this.#sent = candidate.#sent;
      return labels;
    });
    this.#writes = write.then(
      () => {},
      () => {},
    );
    return write;
  }

  collect(
    status: NotificationQuota,
    settings: Settings,
    nowMs = Date.now(),
  ): string[] {
    for (const [key, reset] of this.#sent) {
      if (reset <= nowMs) this.#sent.delete(key);
    }
    if (
      !settings.lowQuotaNotification ||
      !Number.isInteger(settings.lowQuotaThreshold) ||
      settings.lowQuotaThreshold < 1 ||
      settings.lowQuotaThreshold > 99 ||
      status.source === "unavailable" ||
      status.phase !== "connected" ||
      !status.bucketId ||
      !Number.isFinite(nowMs)
    )
      return [];

    const notifications: string[] = [];
    for (const [kind, label, data] of [
      [300, "5-hour limit", status.fiveHour],
      [10080, "Weekly limit", status.weekly],
    ] as const) {
      if (
        data?.state !== "available" ||
        !Number.isFinite(data.remainingPercent) ||
        data.remainingPercent < 0 ||
        data.remainingPercent > settings.lowQuotaThreshold ||
        data.resetsAtMs === null ||
        !Number.isSafeInteger(data.resetsAtMs) ||
        data.resetsAtMs <= nowMs
      )
        continue;
      const key = createHash("sha256")
        .update(JSON.stringify([status.bucketId, kind, data.resetsAtMs]))
        .digest("hex");
      if (this.#sent.has(key)) continue;
      if (this.#sent.size >= 128) continue;
      this.#sent.set(key, data.resetsAtMs);
      notifications.push(label);
    }
    return notifications;
  }
}

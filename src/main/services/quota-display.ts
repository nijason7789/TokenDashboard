import type { QuotaDisplayWindow, QuotaStatus } from "../../shared/contract";
import type { QuotaBucket } from "../codex/rate-limits";
import type { QuotaStatus as MonitorStatus } from "./quota-monitor";

function displayWindow(
  selection?: QuotaBucket["fiveHour"],
): QuotaDisplayWindow {
  if (selection?.state !== "available")
    return { state: selection?.state ?? "missing" };
  const { remainingPercent, resetsAtMs } = selection.window;
  return { state: "available", remainingPercent, resetsAtMs };
}

export function quotaDisplayStatus(
  status?: MonitorStatus,
  source: "monitor" | "mock" = "monitor",
): QuotaStatus {
  if (!status) return { source: "unavailable" };
  const { phase } = status;
  if (phase !== "connected" && phase !== "stale") return { source, phase };
  const { snapshot, updatedAtMs } = status;
  const selection = snapshot.defaultSelection;
  const chosen =
    selection.state === "selected"
      ? snapshot.buckets.find(({ bucketId }) => bucketId === selection.bucketId)
      : undefined;
  const fallback = {
    state: selection.state === "ambiguous" ? "ambiguous" : "missing",
  } as const;
  return {
    source,
    phase,
    updatedAtMs,
    fiveHour: displayWindow(chosen?.fiveHour ?? fallback),
    weekly: displayWindow(chosen?.weekly ?? fallback),
  };
}

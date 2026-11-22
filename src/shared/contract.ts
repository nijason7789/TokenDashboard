export const RENDERER_URL = "app://monitor/index.html";
export const IPC_CHANNELS = Object.freeze({
  status: "quota:status",
  getAlwaysOnTop: "window:get-always-on-top",
  setAlwaysOnTop: "window:set-always-on-top",
  closeWindow: "window:close",
  getSettings: "settings:get",
  updateSettings: "settings:update",
});

export const IPC_EVENTS = Object.freeze({
  status: "quota:changed",
  settings: "settings:changed",
  openSettings: "settings:open",
});

export type QuotaDisplayWindow =
  | { state: "available"; remainingPercent: number; resetsAtMs: number | null }
  | { state: "missing" | "ambiguous" };

export interface QuotaStatus {
  source: "unavailable" | "monitor" | "mock";
  phase?: "connected" | "connecting" | "stale" | "error" | "disconnected";
  updatedAtMs?: number;
  fiveHour?: QuotaDisplayWindow;
  weekly?: QuotaDisplayWindow;
}

export interface QuotaApi {
  getStatus: () => Promise<QuotaStatus>;
  getAlwaysOnTop: () => Promise<boolean>;
  setAlwaysOnTop: (value: boolean) => Promise<boolean>;
  closeWindow: () => Promise<void>;
  getSettings: () => Promise<Settings>;
  updateSettings: (patch: SettingsPatch) => Promise<Settings>;
  onStatusChanged: (listener: (status: QuotaStatus) => void) => () => void;
  onSettingsChanged: (listener: (settings: Settings) => void) => () => void;
  onOpenSettings: (listener: () => void) => () => void;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function timestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 8.64e15
  );
}

function displayWindow(value: unknown): QuotaDisplayWindow | undefined {
  const item = record(value);
  if (item?.state === "missing" || item?.state === "ambiguous")
    return { state: item.state };
  if (item?.state !== "available") return;
  const { remainingPercent, resetsAtMs } = item;
  if (
    typeof remainingPercent !== "number" ||
    !Number.isFinite(remainingPercent) ||
    remainingPercent < 0 ||
    remainingPercent > 100 ||
    (resetsAtMs !== null && !timestamp(resetsAtMs))
  )
    return;
  return { state: "available", remainingPercent, resetsAtMs };
}

export function sanitizedStatus(value: unknown): QuotaStatus | undefined {
  const dto = record(value);
  const source = dto?.source;
  if (source === "unavailable") return { source };
  if (source !== "mock" && source !== "monitor") return;
  const { phase, fiveHour, weekly, updatedAtMs } = dto!;
  if (phase !== "connected" && phase !== "stale")
    return phase === "connecting" ||
      phase === "disconnected" ||
      phase === "error"
      ? { source, phase }
      : undefined;
  const display: QuotaStatus = { source, phase };
  for (const [key, candidate] of [
    ["fiveHour", fiveHour],
    ["weekly", weekly],
  ] as const) {
    if (candidate === undefined) continue;
    const sanitized = displayWindow(candidate);
    if (!sanitized) return;
    display[key] = sanitized;
  }
  if (updatedAtMs !== undefined) {
    if (!timestamp(updatedAtMs)) return;
    display.updatedAtMs = updatedAtMs;
  }
  return display;
}

export function resetCountdownMs(
  resetAtMs: number | null,
  nowMs: number,
): number | null {
  return resetAtMs === null ? null : Math.max(0, resetAtMs - nowMs);
}
import type { Settings, SettingsPatch } from "./settings";

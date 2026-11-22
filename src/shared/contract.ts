export const RENDERER_URL = "app://monitor/index.html";
export const IPC_CHANNELS = Object.freeze({
  status: "quota:status",
  getAlwaysOnTop: "window:get-always-on-top",
  setAlwaysOnTop: "window:set-always-on-top",
  closeWindow: "window:close",
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
}

export function resetCountdownMs(
  resetAtMs: number | null,
  nowMs: number,
): number | null {
  return resetAtMs === null ? null : Math.max(0, resetAtMs - nowMs);
}

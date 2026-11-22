export const RENDERER_URL = "app://monitor/index.html";
export const IPC_CHANNELS = Object.freeze({ status: "quota:status" });

export type QuotaStatus =
  { source: "unavailable" } | { source: "mock"; remaining: number };

export interface QuotaApi {
  getStatus: () => Promise<QuotaStatus>;
}

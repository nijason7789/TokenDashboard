/// <reference types="vite/client" />

import type { QuotaApi } from "../shared/contract";

declare global {
  interface Window {
    quotaMonitor: QuotaApi;
  }
}

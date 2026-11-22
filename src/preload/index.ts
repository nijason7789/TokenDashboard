import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../shared/contract";
import type { QuotaApi } from "../shared/contract";

const api: QuotaApi = {
  getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.status),
};

contextBridge.exposeInMainWorld("quotaMonitor", api);

import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../shared/contract";
import type { QuotaApi } from "../shared/contract";

const api: QuotaApi = {
  getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.status),
  getAlwaysOnTop: () => ipcRenderer.invoke(IPC_CHANNELS.getAlwaysOnTop),
  setAlwaysOnTop: (value) =>
    ipcRenderer.invoke(IPC_CHANNELS.setAlwaysOnTop, value),
  closeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.closeWindow),
};

contextBridge.exposeInMainWorld("quotaMonitor", api);

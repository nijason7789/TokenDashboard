import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  IPC_CHANNELS,
  IPC_EVENTS,
  RENDERER_URL,
  sanitizedStatus,
} from "../shared/contract";
import type { QuotaApi } from "../shared/contract";
import {
  DEFAULT_SETTINGS,
  isSettings,
  type Settings,
} from "../shared/settings";

function listen(channel: string, receive: (...payload: unknown[]) => void) {
  const handler = (_event: IpcRendererEvent, ...payload: unknown[]) => {
    if (process.isMainFrame && location.href === RENDERER_URL)
      receive(...payload);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

function settings(value: unknown): Settings {
  if (!isSettings(value)) throw new Error("Settings unavailable");
  return value;
}

const api: QuotaApi = {
  getStatus: async () =>
    sanitizedStatus(await ipcRenderer.invoke(IPC_CHANNELS.status)) ?? {
      source: "unavailable",
    },
  getAlwaysOnTop: () => ipcRenderer.invoke(IPC_CHANNELS.getAlwaysOnTop),
  setAlwaysOnTop: (value) =>
    ipcRenderer.invoke(IPC_CHANNELS.setAlwaysOnTop, value),
  closeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.closeWindow),
  getSettings: async () => {
    const value: unknown = await ipcRenderer.invoke(IPC_CHANNELS.getSettings);
    return isSettings(value) ? value : { ...DEFAULT_SETTINGS };
  },
  updateSettings: async (patch) =>
    settings(await ipcRenderer.invoke(IPC_CHANNELS.updateSettings, patch)),
  onStatusChanged: (listener) =>
    listen(IPC_EVENTS.status, (...payload) => {
      const value = payload.length === 1 && sanitizedStatus(payload[0]);
      if (value) listener(value);
    }),
  onSettingsChanged: (listener) =>
    listen(IPC_EVENTS.settings, (...payload) => {
      if (payload.length === 1 && isSettings(payload[0])) listener(payload[0]);
    }),
  onOpenSettings: (listener) =>
    listen(IPC_EVENTS.openSettings, (...payload) => {
      if (!payload.length) listener();
    }),
};

contextBridge.exposeInMainWorld("quotaMonitor", api);

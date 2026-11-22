import { expect, it, vi } from "vitest";

const { expose, invoke, on, removeListener } = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { invoke, on, removeListener },
}));

it("exposes only typed quota and window operations", async () => {
  await import("../src/preload/index");
  expect(expose).toHaveBeenCalledTimes(1);
  const [key, api] = expose.mock.calls[0]!;
  expect(key).toBe("quotaMonitor");
  expect(Object.keys(api)).toEqual([
    "getStatus",
    "getAlwaysOnTop",
    "setAlwaysOnTop",
    "closeWindow",
    "getSettings",
    "updateSettings",
    "onStatusChanged",
    "onSettingsChanged",
    "onOpenSettings",
  ]);
  api.getStatus({ arbitrary: true });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("quota:status");
  invoke.mockClear();
  api.getAlwaysOnTop("extra");
  api.setAlwaysOnTop(true, "extra");
  api.closeWindow("extra");
  expect(invoke.mock.calls).toEqual([
    ["window:get-always-on-top"],
    ["window:set-always-on-top", true],
    ["window:close"],
  ]);
});

it("delivers only valid sanitized payloads to the owning preload and supports unsubscribe", async () => {
  await import("../src/preload/index");
  const api = expose.mock.calls[0]![1];
  const callback = vi.fn();
  const off = api.onStatusChanged(callback);
  const [channel, receive] = on.mock.calls[0]!;
  expect(channel).toBe("quota:changed");
  const original = Object.getOwnPropertyDescriptor(process, "isMainFrame");
  Object.defineProperty(process, "isMainFrame", {
    configurable: true,
    writable: true,
    value: true,
  });
  vi.stubGlobal("location", { href: "app://monitor/index.html" });
  try {
    receive(
      { raw: "ipc event" },
      { source: "mock", phase: "connected", secret: "private" },
    );
    receive(
      {},
      {
        source: "mock",
        phase: "connected",
        weekly: { state: "available", remainingPercent: 101 },
      },
    );
    receive({}, { source: "unavailable" }, "extra");
    location.href = "app://monitor/index.html#different";
    receive({}, { source: "unavailable" });
    expect(callback).toHaveBeenCalledExactlyOnceWith({
      source: "mock",
      phase: "connected",
    });
    off();
    expect(removeListener).toHaveBeenCalledExactlyOnceWith(channel, receive);
  } finally {
    if (original) Object.defineProperty(process, "isMainFrame", original);
    else Reflect.deleteProperty(process, "isMainFrame");
    vi.unstubAllGlobals();
  }
});

import { expect, it, vi } from "vitest";

const { expose, invoke } = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { invoke },
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

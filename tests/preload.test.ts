import { expect, it, vi } from "vitest";

const { expose, invoke } = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { invoke },
}));

it("exposes only the typed status request and forwards no caller arguments", async () => {
  await import("../src/preload/index");
  expect(expose).toHaveBeenCalledTimes(1);
  const [key, api] = expose.mock.calls[0]!;
  expect(key).toBe("quotaMonitor");
  expect(Object.keys(api)).toEqual(["getStatus"]);
  api.getStatus({ arbitrary: true });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("quota:status");
});

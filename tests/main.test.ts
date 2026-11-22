import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { RENDERER_URL } from "../src/shared/contract";

const mocks = vi.hoisted(() => {
  const contents = {
    mainFrame: { url: "app://monitor/index.html" },
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
  };
  const window = {
    webContents: contents,
    on: vi.fn(),
    loadURL: vi.fn(),
    show: vi.fn(),
    close: vi.fn(),
    isAlwaysOnTop: vi.fn(() => false),
    setAlwaysOnTop: vi.fn(),
    getBounds: vi.fn(() => ({ x: 1400, y: 0, width: 360, height: 340 })),
    setBounds: vi.fn(),
  };
  const session = {
    protocol: { handle: vi.fn() },
    webRequest: { onBeforeRequest: vi.fn() },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    on: vi.fn(),
  };
  return {
    window,
    session,
    createWindow: vi.fn(function () {
      return window;
    }),
    ipc: { handle: vi.fn(), removeHandler: vi.fn() },
    readFile: vi.fn(async () => new Uint8Array()),
    exit: vi.fn(),
    screen: {
      getPrimaryDisplay: vi.fn(() => ({
        workArea: { x: 0, y: 0, width: 1280, height: 720 },
      })),
      getAllDisplays: vi.fn(() => [
        { workArea: { x: 0, y: 0, width: 1280, height: 720 } },
      ]),
      on: vi.fn(),
      off: vi.fn(),
    },
  };
});

vi.mock("electron", () => ({
  app: { on: vi.fn(), whenReady: async () => {}, exit: mocks.exit },
  BrowserWindow: mocks.createWindow,
  ipcMain: mocks.ipc,
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  session: { fromPartition: () => mocks.session },
  screen: mocks.screen,
}));
vi.mock("node:fs/promises", () => ({
  readdir: async () => [
    { name: "index-abc.js", isFile: () => true },
    { name: "index-abc.css", isFile: () => true },
    { name: "fixture.json", isFile: () => true },
    { name: "nested.js", isFile: () => false },
  ],
  readFile: mocks.readFile,
}));

it("wires the production boundaries and denies requests outside the asset and IPC allowlists", async () => {
  await import("../src/main/index");
  await vi.waitFor(() => expect(mocks.window.show).toHaveBeenCalledOnce());
  expect(mocks.exit).not.toHaveBeenCalled();
  expect(mocks.createWindow).toHaveBeenCalledWith(
    expect.objectContaining({
      frame: false,
      resizable: true,
      webPreferences: expect.objectContaining({
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        devTools: false,
      }),
    }),
  );
  expect(mocks.window.loadURL).toHaveBeenCalledExactlyOnceWith(RENDERER_URL);
  expect(
    mocks.window.webContents.setWindowOpenHandler.mock.calls[0]![0](),
  ).toEqual({ action: "deny" });
  for (const event of [
    "will-frame-navigate",
    "will-redirect",
    "will-attach-webview",
  ]) {
    const preventDefault = vi.fn();
    const handler = mocks.window.webContents.on.mock.calls.find(
      ([name]) => name === event,
    )?.[1];
    handler({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
  }
  const permission = vi.fn();
  mocks.session.setPermissionRequestHandler.mock.calls[0]![0](
    null,
    "notifications",
    permission,
  );
  expect(permission).toHaveBeenCalledExactlyOnceWith(false);
  expect(mocks.session.setPermissionCheckHandler.mock.calls[0]![0]()).toBe(
    false,
  );

  const handler = mocks.session.protocol.handle.mock.calls[0]![1];
  for (const url of [
    "app://monitor/extra.html",
    "app://monitor/assets/fixture.json",
    "https://example.invalid",
  ]) {
    expect((await handler({ url, method: "GET" })).status).toBe(404);
  }
  expect((await handler({ url: RENDERER_URL, method: "POST" })).status).toBe(
    404,
  );
  expect(mocks.readFile).not.toHaveBeenCalled();
  const response: Response = await handler({
    url: RENDERER_URL,
    method: "GET",
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Security-Policy")).toContain(
    "connect-src 'none'",
  );
  expect(mocks.readFile).toHaveBeenCalledWith(
    expect.stringContaining(join("renderer", "index.html")),
  );
  const gate = vi.fn();
  mocks.session.webRequest.onBeforeRequest.mock.calls[0]![0](
    { url: "https://example.invalid" },
    gate,
  );
  expect(gate).toHaveBeenCalledExactlyOnceWith({ cancel: true });

  const [channel, read] = mocks.ipc.handle.mock.calls[0]!;
  expect(mocks.ipc.handle).toHaveBeenCalledTimes(4);
  expect(channel).toBe("quota:status");
  const sender = mocks.window.webContents;
  expect(() =>
    read({ sender: { ...sender }, senderFrame: sender.mainFrame }),
  ).toThrow();
  expect(() =>
    read({ sender, senderFrame: sender.mainFrame }, "extra"),
  ).toThrow();
  expect(read({ sender, senderFrame: sender.mainFrame })).toEqual({
    source: "unavailable",
  });
  const windowHandler = (channel: string) =>
    mocks.ipc.handle.mock.calls.find(([name]) => name === channel)![1];
  expect(
    windowHandler("window:get-always-on-top")({
      sender,
      senderFrame: sender.mainFrame,
    }),
  ).toBe(false);
  windowHandler("window:set-always-on-top")(
    { sender, senderFrame: sender.mainFrame },
    true,
  );
  expect(mocks.window.setAlwaysOnTop).toHaveBeenCalledWith(true);
  expect(() =>
    windowHandler("window:set-always-on-top")(
      { sender, senderFrame: sender.mainFrame },
      "true",
    ),
  ).toThrow();
  windowHandler("window:close")({ sender, senderFrame: sender.mainFrame });
  expect(mocks.window.close).toHaveBeenCalledOnce();
  mocks.screen.on.mock.calls[0]![1]();
  expect(mocks.window.setBounds).toHaveBeenCalledWith({
    x: 920,
    y: 0,
    width: 360,
    height: 340,
  });
  mocks.window.on.mock.calls.find(([name]) => name === "closed")![1]();
  expect(mocks.ipc.removeHandler).toHaveBeenCalledTimes(4);
  expect(mocks.screen.off).toHaveBeenCalledTimes(3);
});

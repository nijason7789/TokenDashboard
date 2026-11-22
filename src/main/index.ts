import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  screen,
  session,
} from "electron";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { IPC_CHANNELS, RENDERER_URL } from "../shared/contract";
import { createStatusHandler, createWindowHandler } from "./ipc";
import { visibleBounds } from "./window-bounds";

const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true } },
]);

async function createWindow() {
  const renderer = session.fromPartition("monitor");
  const root = join(__dirname, "renderer");
  const assets = new Map([
    [
      RENDERER_URL,
      { path: join(root, "index.html"), type: "text/html; charset=utf-8" },
    ],
  ]);
  for (const asset of await readdir(join(root, "assets"), {
    withFileTypes: true,
  })) {
    if (!asset.isFile() || !/^[\w-]+\.(js|css)$/.test(asset.name)) continue;
    const url = new URL(`assets/${asset.name}`, RENDERER_URL).href;
    assets.set(url, {
      path: join(root, "assets", asset.name),
      type: asset.name.endsWith(".js") ? "text/javascript" : "text/css",
    });
  }

  renderer.protocol.handle("app", async ({ method, url }) => {
    const asset = assets.get(url);
    if (method !== "GET" || !asset) return new Response(null, { status: 404 });

    return new Response(await readFile(asset.path), {
      headers: {
        "Content-Type": asset.type,
        "Content-Security-Policy": csp,
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  renderer.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !assets.has(details.url) }),
  );
  renderer.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  renderer.setPermissionCheckHandler(() => false);
  renderer.on("will-download", (event) => event.preventDefault());

  const workArea = screen.getPrimaryDisplay().workArea;
  const initialBounds = visibleBounds(
    {
      x: workArea.x + workArea.width - 380,
      y: workArea.y + 24,
      width: 360,
      height: 360,
    },
    [workArea],
  );
  const window = new BrowserWindow({
    ...initialBounds,
    minWidth: Math.min(300, workArea.width),
    minHeight: Math.min(240, workArea.height),
    frame: false,
    resizable: true,
    show: false,
    backgroundColor: "#141922",
    webPreferences: {
      session: renderer,
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      devTools: false,
    },
  });

  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-frame-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());

  ipcMain.handle(
    IPC_CHANNELS.status,
    createStatusHandler(contents, () => ({ source: "unavailable" as const })),
  );
  const noArguments = (args: unknown[]) => args.length === 0;
  ipcMain.handle(
    IPC_CHANNELS.getAlwaysOnTop,
    createWindowHandler(contents, () => window.isAlwaysOnTop(), noArguments),
  );
  ipcMain.handle(
    IPC_CHANNELS.setAlwaysOnTop,
    createWindowHandler(
      contents,
      (value) => {
        window.setAlwaysOnTop(value as boolean);
        return window.isAlwaysOnTop();
      },
      (args) => args.length === 1 && typeof args[0] === "boolean",
    ),
  );
  ipcMain.handle(
    IPC_CHANNELS.closeWindow,
    createWindowHandler(contents, () => window.close(), noArguments),
  );

  const fitToDisplays = () => {
    const bounds = window.getBounds();
    const fitted = visibleBounds(
      bounds,
      screen.getAllDisplays().map((display) => display.workArea),
    );
    if (
      bounds.x !== fitted.x ||
      bounds.y !== fitted.y ||
      bounds.width !== fitted.width ||
      bounds.height !== fitted.height
    )
      window.setBounds(fitted);
  };
  screen.on("display-added", fitToDisplays);
  screen.on("display-removed", fitToDisplays);
  screen.on("display-metrics-changed", fitToDisplays);
  window.on("closed", () => {
    screen.off("display-added", fitToDisplays);
    screen.off("display-removed", fitToDisplays);
    screen.off("display-metrics-changed", fitToDisplays);
    for (const channel of Object.values(IPC_CHANNELS))
      ipcMain.removeHandler(channel);
  });
  await window.loadURL(RENDERER_URL);
  window.show();
}

app.on("window-all-closed", () => app.quit());
void app
  .whenReady()
  .then(createWindow)
  .catch(() => {
    console.error("Could not start Codex Quota Monitor.");
    app.exit(1);
  });

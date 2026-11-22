import { app, BrowserWindow, ipcMain, protocol, session } from "electron";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { IPC_CHANNELS, RENDERER_URL } from "../shared/contract";
import { createStatusHandler } from "./ipc";

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

  const window = new BrowserWindow({
    width: 400,
    height: 240,
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
  window.on("closed", () => ipcMain.removeHandler(IPC_CHANNELS.status));
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

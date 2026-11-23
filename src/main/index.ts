import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  protocol,
  screen,
  session,
  Tray,
} from "electron";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  IPC_CHANNELS,
  IPC_EVENTS,
  RENDERER_URL,
  sanitizedStatus,
} from "../shared/contract";
import { isSettingsPatch, type SettingsPatch } from "../shared/settings";
import { createStatusHandler, createWindowHandler } from "./ipc";
import { LowQuotaNotifications } from "./quota-notifications";
import { SettingsStore } from "./settings";
import { trayMenu } from "./tray-menu";
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
  const store = new SettingsStore(app.getPath("userData"));
  const saved = await store.load();
  let settings = saved.settings;
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
    saved.bounds ?? {
      x: workArea.x + workArea.width - 380,
      y: workArea.y + 24,
      width: 360,
      height: 360,
    },
    screen.getAllDisplays().map((display) => display.workArea),
  );
  const window = new BrowserWindow({
    ...initialBounds,
    minWidth: Math.min(300, initialBounds.width),
    minHeight: Math.min(240, initialBounds.height),
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
  const pinWindow = (value: boolean) => {
    // The floating level is placed behind the Windows taskbar, which can
    // demote it in sessions where Explorer does not make the taskbar topmost.
    window.setAlwaysOnTop(
      value,
      process.platform === "win32" ? "pop-up-menu" : "floating",
    );
  };
  if (settings.opacity !== 1) window.setOpacity(settings.opacity);
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-frame-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());

  const quotaNotifications = new LowQuotaNotifications(saved.notificationState);
  // The authenticated source remains disconnected. Only this DTO reaches Renderer.
  const refresh = () => {
    const current = { source: "unavailable" } as const;
    const status = sanitizedStatus(current)!;
    if (quitting) return status;
    contents.send(IPC_EVENTS.status, status);
    if (settings.lowQuotaNotification && Notification.isSupported()) {
      void serialize(async () => {
        if (quitting) return;
        const labels = await quotaNotifications.persistAndCollect(
          current,
          settings,
          (state) => store.save(settings, window.getNormalBounds(), state),
        );
        for (const label of labels)
          new Notification({
            title: "Codex quota",
            body: label + " is below your threshold.",
          }).show();
      }).catch(() => console.error("Could not record quota notifications."));
    }
    return status;
  };

  let writes = Promise.resolve();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let quitting = false;
  let readyToQuit = false;
  const serialize = <T>(action: () => Promise<T>) => {
    const next = writes.then(action);
    writes = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  const loginOptions = { path: process.execPath, args: [] };
  const setStartup = (enabled: boolean) => {
    app.setLoginItemSettings({ ...loginOptions, openAtLogin: enabled });
    if (app.getLoginItemSettings(loginOptions).openAtLogin !== enabled)
      throw new Error("Startup settings unavailable");
  };
  const updateSettings = (patch: SettingsPatch | (() => SettingsPatch)) =>
    serialize(async () => {
      if (quitting) throw new Error("Settings unavailable");
      const next = {
        ...settings,
        ...(typeof patch === "function" ? patch() : patch),
      };
      const startupChanged = next.launchOnStartup !== settings.launchOnStartup;
      if (
        startupChanged &&
        (process.platform !== "win32" ||
          !app.isPackaged ||
          process.env.PORTABLE_EXECUTABLE_FILE !== undefined)
      )
        throw new Error("Startup settings unavailable");
      const pinChanged = next.alwaysOnTop !== settings.alwaysOnTop;
      try {
        if (startupChanged) setStartup(next.launchOnStartup);
        if (pinChanged) pinWindow(next.alwaysOnTop);
        await store.save(next, window.getNormalBounds());
      } catch {
        if (pinChanged) pinWindow(settings.alwaysOnTop);
        if (startupChanged) {
          try {
            setStartup(settings.launchOnStartup);
          } catch {
            console.error("Could not restore startup settings.");
          }
        }
        throw new Error("Settings could not be saved");
      }
      const previous = settings;
      settings = next;
      if (settings.opacity !== previous.opacity)
        window.setOpacity(settings.opacity);
      updateMenu();
      if (!quitting) contents.send(IPC_EVENTS.settings, settings);
      return settings;
    });
  const scheduleBoundsSave = () => {
    clearTimeout(saveTimer);
    if (quitting) return;
    saveTimer = setTimeout(() => {
      void serialize(() =>
        store.save(settings, window.getNormalBounds()),
      ).catch(() => {
        console.error("Could not save window bounds.");
      });
    }, 250);
  };

  const noArguments = (args: unknown[]) => args.length === 0;
  ipcMain.handle(IPC_CHANNELS.status, createStatusHandler(contents, refresh));
  ipcMain.handle(
    IPC_CHANNELS.getSettings,
    createStatusHandler(contents, () => settings),
  );
  ipcMain.handle(
    IPC_CHANNELS.updateSettings,
    createWindowHandler(
      contents,
      (patch) => updateSettings(patch as SettingsPatch),
      (args) => args.length === 1 && isSettingsPatch(args[0]),
    ),
  );
  ipcMain.handle(
    IPC_CHANNELS.getAlwaysOnTop,
    createWindowHandler(contents, () => window.isAlwaysOnTop(), noArguments),
  );
  ipcMain.handle(
    IPC_CHANNELS.setAlwaysOnTop,
    createWindowHandler(
      contents,
      async (value) =>
        (await updateSettings({ alwaysOnTop: value as boolean })).alwaysOnTop,
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
    ) {
      window.setMinimumSize(
        Math.min(300, fitted.width),
        Math.min(240, fitted.height),
      );
      window.setBounds(fitted);
    }
  };
  const show = () => {
    if (quitting) return;
    if (window.isMinimized()) window.restore();
    fitToDisplays();
    window.show();
    if (settings.alwaysOnTop && !window.isAlwaysOnTop()) pinWindow(true);
    window.focus();
  };
  const toggleVisibility = () => {
    if (quitting) return;
    if (window.isVisible()) window.hide();
    else show();
  };
  const bitmap = Buffer.alloc(16 * 16 * 4);
  for (let y = 2; y < 14; y++)
    for (let x = 2; x < 14; x++) {
      const index = (y * 16 + x) * 4;
      const bar =
        (x >= 4 && x <= 6 && y >= 8 && y <= 11) ||
        (x >= 9 && x <= 11 && y >= 4 && y <= 11);
      bitmap.set(bar ? [164, 213, 95, 255] : [40, 30, 24, 255], index);
    }
  const tray = new Tray(
    nativeImage.createFromBitmap(bitmap, { width: 16, height: 16 }),
  );
  tray.setToolTip("Codex Quota Monitor");
  const updateMenu = () => {
    if (quitting) return;
    const apply = (patch: () => SettingsPatch) => {
      void updateSettings(patch).catch(() =>
        console.error("Could not save tray settings."),
      );
    };
    tray.setContextMenu(
      Menu.buildFromTemplate(
        trayMenu(window.isVisible(), settings, {
          toggleVisibility,
          refresh,
          togglePin: () =>
            apply(() => ({ alwaysOnTop: !settings.alwaysOnTop })),
          toggleCompact: () => apply(() => ({ compact: !settings.compact })),
          openSettings: () => {
            if (!quitting) {
              show();
              contents.send(IPC_EVENTS.openSettings);
            }
          },
          quit: () => app.quit(),
        }),
      ),
    );
  };
  tray.on("click", toggleVisibility);
  window.on("show", updateMenu);
  window.on("hide", updateMenu);
  window.on("move", scheduleBoundsSave);
  window.on("resize", scheduleBoundsSave);
  window.on("minimize", () => {
    if (!quitting) window.hide();
  });
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (settings.closeToTray) window.hide();
    else app.quit();
  });
  const beforeQuit = (event: { preventDefault(): void }) => {
    if (readyToQuit) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    clearTimeout(saveTimer);
    const bounds = window.getNormalBounds();
    tray.destroy();
    void serialize(() => store.save(settings, bounds))
      .catch(() => {
        console.error("Could not save window bounds.");
      })
      .finally(() => {
        readyToQuit = true;
        app.quit();
      });
  };
  app.on("before-quit", beforeQuit);
  app.on("second-instance", show);
  screen.on("display-added", fitToDisplays);
  screen.on("display-removed", fitToDisplays);
  screen.on("display-metrics-changed", fitToDisplays);
  window.on("closed", () => {
    app.off("before-quit", beforeQuit);
    app.off("second-instance", show);
    clearTimeout(saveTimer);
    if (!tray.isDestroyed()) tray.destroy();
    screen.off("display-added", fitToDisplays);
    screen.off("display-removed", fitToDisplays);
    screen.off("display-metrics-changed", fitToDisplays);
    for (const channel of Object.values(IPC_CHANNELS))
      ipcMain.removeHandler(channel);
  });
  try {
    await window.loadURL(RENDERER_URL);
    show();
    updateMenu();
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("window-all-closed", () => app.quit());
  void app
    .whenReady()
    .then(createWindow)
    .catch(() => {
      console.error("Could not start Codex Quota Monitor.");
      app.exit(1);
    });
}

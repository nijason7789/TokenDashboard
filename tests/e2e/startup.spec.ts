import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRateLimitsResponse } from "../../src/main/codex/rate-limits";
import { quotaDisplayStatus } from "../../src/main/services/quota-display";
import {
  IPC_CHANNELS,
  IPC_EVENTS,
  RENDERER_URL,
} from "../../src/shared/contract";

let profile: string;
test.beforeEach(async () => {
  profile = await mkdtemp(join(tmpdir(), "quota-e2e-"));
});
test.afterEach(async () => {
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
});
const launch = () =>
  electron.launch({ args: [".", "--user-data-dir=" + profile] });

test("opens the production renderer without a mock provider", async () => {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveURL("app://monitor/index.html");
    await expect(
      page.getByRole("heading", { name: "Codex Quota Monitor" }),
    ).toBeVisible();
    await expect(page.getByRole("status")).toHaveText(
      "Quota source unavailable",
    );
    const native = await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const bounds = window.getBounds();
      const work = screen.getDisplayMatching(bounds).workArea;
      return {
        resizable: window.isResizable(),
        inWorkArea:
          bounds.x >= work.x &&
          bounds.y >= work.y &&
          bounds.x + bounds.width <= work.x + work.width &&
          bounds.y + bounds.height <= work.y + work.height,
      };
    });
    expect(native).toEqual({ resizable: true, inWorkArea: true });
    expect(
      await page.evaluate(() => Object.keys(window.quotaMonitor).sort()),
    ).toEqual([
      "closeWindow",
      "getAlwaysOnTop",
      "getSettings",
      "getStatus",
      "onOpenSettings",
      "onSettingsChanged",
      "onStatusChanged",
      "setAlwaysOnTop",
      "updateSettings",
    ]);
    expect(
      await page.evaluate(() => typeof Reflect.get(window, "require")),
    ).toBe("undefined");
    expect(
      await page.evaluate(() => typeof Reflect.get(window, "process")),
    ).toBe("undefined");
    expect(await page.evaluate(() => window.open("about:blank") === null)).toBe(
      true,
    );
    expect(
      await page.evaluate(async () => Notification.requestPermission()),
    ).toBe("denied");
    await page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "document.body.dataset.inlineScriptRan = 'yes'";
      document.body.append(script);
    });
    expect(
      await page.locator("body").getAttribute("data-inline-script-ran"),
    ).toBeNull();
  } finally {
    await app.close();
  }
});

test("renders and refreshes explicitly injected quota fixtures in Electron", async () => {
  const now = Date.now();
  const bucket = {
    limitId: "codex",
    primary: {
      usedPercent: 25,
      windowDurationMins: 300,
      resetsAt: Math.floor(now / 1000) + 1800,
    },
    secondary: {
      usedPercent: 85,
      windowDurationMins: 10080,
      resetsAt: Math.floor(now / 1000) + 86400,
    },
  };
  const snapshot = parseRateLimitsResponse({ rateLimits: bucket });
  const updates = [
    quotaDisplayStatus(
      { phase: "connected", snapshot, updatedAtMs: now },
      "mock",
    ),
    quotaDisplayStatus({ phase: "error", reason: "transport" }, "mock"),
    quotaDisplayStatus(
      { phase: "connected", snapshot, updatedAtMs: now },
      "mock",
    ),
  ];

  const app = await launch();
  try {
    const page = await app.firstWindow();
    await expect(page.getByText("Quota source unavailable")).toBeVisible();
    // Only Playwright's privileged test driver can inject this provider.
    await app.evaluate(
      ({ ipcMain, BrowserWindow }, { channel, url, updates }) => {
        const owner = BrowserWindow.getAllWindows()[0]?.webContents;
        let index = 0;
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (event, ...args: unknown[]) => {
          if (
            !owner ||
            event.sender !== owner ||
            event.senderFrame !== owner.mainFrame ||
            event.senderFrame.url !== url ||
            args.length
          )
            throw new Error("Unauthorized test request");
          return updates[Math.min(index++, updates.length - 1)];
        });
      },
      { channel: IPC_CHANNELS.status, url: RENDERER_URL, updates },
    );

    const refresh = page.getByRole("button", { name: "Refresh" });
    await refresh.click();
    await expect(page.getByText(/mock/i).first()).toBeVisible();
    await expect(page.getByText("75%", { exact: true })).toBeVisible();
    await expect(page.getByText("15%", { exact: true })).toBeVisible();
    await expect(page.getByRole("progressbar")).toHaveCount(2);
    await expect(page.locator(".quota-meta time")).toHaveCount(2);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(300, 340),
    );
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(300);
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);

    const compact = page.getByRole("button", { name: "Compact mode" });
    await compact.click();
    await expect(
      page.getByRole("button", { name: "Normal mode" }),
    ).toHaveAttribute("aria-pressed", "true");

    await expect(page.locator(".quota-meta time")).toHaveCount(0);
    const pin = page.getByRole("button", { name: "Always on top" });
    await expect(pin).toHaveAttribute("aria-pressed", "false");
    expect(
      await page.evaluate(() => window.quotaMonitor.getAlwaysOnTop()),
    ).toBe(false);
    await pin.click();
    await expect(pin).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.isAlwaysOnTop(),
        ),
      )
      .toBe(true);
    await pin.click();
    await expect(pin).toHaveAttribute("aria-pressed", "false");

    await refresh.click();
    await expect(page.getByRole("status")).toContainText("Error");
    await refresh.click();
    await expect(page.getByRole("status")).toContainText("Connected");
  } finally {
    await app.close();
  }
});

test("receives sanitized status events and persists settings and bounds across quit", async () => {
  let app = await launch();
  let child = app.process();
  try {
    let page = await app.firstWindow();
    expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(
      profile,
    );
    await expect(page.getByRole("status")).toHaveText(
      "Quota source unavailable",
    );
    expect(
      (await page.evaluate(() => window.quotaMonitor.getSettings()))
        .launchOnStartup,
    ).toBe(false);
    await app.evaluate(
      ({ BrowserWindow }, { channel, open }) => {
        const contents = BrowserWindow.getAllWindows()[0]!.webContents;
        contents.send(channel, {
          source: "mock",
          phase: "connected",
          fiveHour: {
            state: "available",
            remainingPercent: 66,
            resetsAtMs: null,
          },
          secret: "raw-sensitive-probe",
        });
        contents.send(open);
      },
      { channel: IPC_EVENTS.status, open: IPC_EVENTS.openSettings },
    );
    await expect(page.getByText("Mock data")).toBeVisible();
    await expect(page.getByText("66%", { exact: true })).toBeVisible();
    await expect(page.getByText("raw-sensitive-probe")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Close settings" }),
    ).toBeVisible();

    await page.evaluate(() =>
      window.quotaMonitor.updateSettings({
        compact: true,
        opacity: 0.8,
        closeToTray: true,
        percentageMode: "used",
        refreshInterval: 120,
      }),
    );
    await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      const { x, y } = screen.getDisplayMatching(window.getBounds()).workArea;
      window.setBounds({ x: x + 40, y: y + 40, width: 410, height: 440 });
    });
    const bounds = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.getNormalBounds(),
    );
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.getByRole("button", { name: "Close window" }).click();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.isVisible(),
        ),
      )
      .toBe(false);
    await app.evaluate(({ app }) => {
      app.emit("second-instance", {}, [], "", {});
    });
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.isVisible(),
        ),
      )
      .toBe(true);
    await app.close();
    expect(child.exitCode).toBe(0);

    app = await launch();
    child = app.process();
    page = await app.firstWindow();
    await expect(
      page.getByRole("button", { name: "Normal mode" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      await page.evaluate(() => window.quotaMonitor.getSettings()),
    ).toMatchObject({
      compact: true,
      opacity: 0.8,
      closeToTray: true,
      percentageMode: "used",
      refreshInterval: 120,
      launchOnStartup: false,
    });
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getNormalBounds(),
      ),
    ).toEqual(bounds);
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getOpacity(),
      ),
    ).toBeCloseTo(0.8, 2);
    await expect(page.getByRole("status")).toHaveText(
      "Quota source unavailable",
    );
  } finally {
    if (child.exitCode === null) await app.close();
  }
});

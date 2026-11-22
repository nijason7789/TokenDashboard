import { expect, it, vi } from "vitest";
import { trayMenu } from "../src/main/tray-menu";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
it("uses one action for each tray operation and reflects settings/visibility", () => {
  const commands = {
    toggleVisibility: vi.fn(),
    refresh: vi.fn(),
    togglePin: vi.fn(),
    toggleCompact: vi.fn(),
    openSettings: vi.fn(),
    quit: vi.fn(),
  };
  const menu = trayMenu(
    true,
    { ...DEFAULT_SETTINGS, alwaysOnTop: true },
    commands,
  );
  expect(menu.map((item) => item.label).filter(Boolean)).toEqual([
    "Hide window",
    "Refresh quota",
    "Always on top",
    "Compact mode",
    "Settings",
    "Quit",
  ]);
  expect(menu[2]?.checked).toBe(true);
  expect(menu[3]?.checked).toBe(false);
  for (const item of menu) item.click?.();
  for (const command of Object.values(commands))
    expect(command).toHaveBeenCalledOnce();
  expect(trayMenu(false, DEFAULT_SETTINGS, commands)[0]?.label).toBe(
    "Show window",
  );
});

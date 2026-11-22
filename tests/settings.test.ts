import { expect, it, vi } from "vitest";
import { SettingsStore } from "../src/main/settings";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import { LowQuotaNotifications } from "../src/main/quota-notifications";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function storage() {
  const files = new Map<string, string>();
  return {
    files,
    readFile: vi.fn(async (path: string) => {
      if (!files.has(path)) throw new Error("missing");
      return files.get(path)!;
    }),
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async (path: string, body: string) => {
      files.set(path, body);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      files.set(to, files.get(from)!);
      files.delete(from);
    }),
    rm: vi.fn(async (path: string) => {
      files.delete(path);
    }),
  };
}

it("loads defaults for absent or corrupted files", async () => {
  const disk = storage();
  const store = new SettingsStore("fixture", disk);
  expect(await store.load()).toEqual({ settings: DEFAULT_SETTINGS });
  await store.save(DEFAULT_SETTINGS);
  const path = [...disk.files.keys()][0]!;
  disk.files.set(path, "{bad json");
  expect(await store.load()).toEqual({ settings: DEFAULT_SETTINGS });
});

it("roundtrips only allowlisted preferences and valid bounds", async () => {
  const disk = storage();
  const store = new SettingsStore("fixture", disk);
  const bounds = { x: -1920, y: 24, width: 360, height: 340 };
  await store.save({ ...DEFAULT_SETTINGS, compact: true }, bounds);
  expect(await store.load()).toEqual({
    settings: { ...DEFAULT_SETTINGS, compact: true },
    bounds,
  });
  expect(disk.rename).toHaveBeenCalledOnce();
  expect(disk.files.size).toBe(1);
  const [path] = disk.files.keys();
  disk.files.set(
    path!,
    JSON.stringify({
      settings: {
        compact: true,
        opacity: 0.1,
        launchOnStartup: "yes",
        token: "fixture",
      },
      bounds: { ...bounds, width: -1 },
      raw: "fixture",
    }),
  );
  expect(await store.load()).toEqual({
    settings: { ...DEFAULT_SETTINGS, compact: true },
  });
});

it("rejects incomplete, unknown or invalid settings before touching disk", async () => {
  const disk = storage();
  const store = new SettingsStore("fixture", disk);
  await expect(
    store.save({ compact: true } as typeof DEFAULT_SETTINGS),
  ).rejects.toThrow("Invalid settings");
  await expect(store.save({ ...DEFAULT_SETTINGS, opacity: 0 })).rejects.toThrow(
    "Invalid settings",
  );
  await expect(
    store.save({
      ...DEFAULT_SETTINGS,
      secret: "fixture",
    } as typeof DEFAULT_SETTINGS),
  ).rejects.toThrow("Invalid settings");
  await expect(
    store.save(DEFAULT_SETTINGS, { x: NaN, y: 0, width: 1, height: 1 }),
  ).rejects.toThrow("Invalid window bounds");
  expect(disk.writeFile).not.toHaveBeenCalled();
});

it("keeps the prior file on rename failure and allows a later save", async () => {
  const disk = storage();
  const store = new SettingsStore("fixture", disk);
  await store.save(DEFAULT_SETTINGS);
  disk.rename.mockRejectedValueOnce(new Error("sensitive path"));
  await expect(
    store.save({ ...DEFAULT_SETTINGS, compact: true }),
  ).rejects.toThrow("Could not save preferences");
  await expect(store.flush()).rejects.toThrow("Could not save preferences");
  expect(await store.load()).toEqual({ settings: DEFAULT_SETTINGS });
  expect(disk.files.size).toBe(1);
  await store.save({ ...DEFAULT_SETTINGS, alwaysOnTop: true });
  await store.flush();
  expect(await store.load()).toEqual({
    settings: { ...DEFAULT_SETTINGS, alwaysOnTop: true },
  });
});

it("serializes saves in order and snapshots caller values", async () => {
  const disk = storage();
  const store = new SettingsStore("fixture", disk);
  const settings = { ...DEFAULT_SETTINGS, compact: true };
  const first = store.save(settings);
  settings.compact = false;
  const second = store.save({ ...DEFAULT_SETTINGS, opacity: 0.75 });
  await Promise.all([first, second]);
  const firstBody = JSON.parse(disk.writeFile.mock.calls[0]![1]);
  expect(firstBody.settings.compact).toBe(true);
  expect(await store.load()).toEqual({
    settings: { ...DEFAULT_SETTINGS, opacity: 0.75 },
  });
});

it("roundtrips notification state without raw bucket identities and preserves it during settings-only saves", async () => {
  const disk = storage();
  const store = new SettingsStore("fixture", disk);
  const policy = new LowQuotaNotifications();
  policy.collect(
    {
      source: "mock",
      phase: "connected",
      bucketId: "codex",
      fiveHour: { state: "available", remainingPercent: 1, resetsAtMs: 5000 },
    },
    { ...DEFAULT_SETTINGS, lowQuotaNotification: true },
    0,
  );
  await store.save(DEFAULT_SETTINGS, undefined, policy.snapshot());
  await store.save({ ...DEFAULT_SETTINGS, compact: true });
  const loaded = await store.load();
  expect(loaded.notificationState).toEqual(policy.snapshot());
  expect(JSON.stringify(loaded)).not.toContain("codex");
  await store.save(DEFAULT_SETTINGS, undefined, []);
  expect((await store.load()).notificationState).toBeUndefined();
});

it("replaces preferences atomically through the actual local filesystem", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quota-settings-test-"));
  try {
    const store = new SettingsStore(directory);
    await store.save(DEFAULT_SETTINGS);
    await store.save({ ...DEFAULT_SETTINGS, compact: true });
    expect((await new SettingsStore(directory).load()).settings.compact).toBe(
      true,
    );
  } finally {
    if (!directory.startsWith(join(tmpdir(), "quota-settings-test-")))
      throw new Error("Unsafe test cleanup");
    await rm(directory, { recursive: true, force: true });
  }
});

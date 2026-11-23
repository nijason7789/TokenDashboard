import { promises as files } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_SETTINGS,
  isSettingsPatch,
  type Settings,
} from "../shared/settings";
import type { WindowBounds } from "./window-bounds";
import {
  notificationState as validatedNotificationState,
  type NotificationState,
} from "./quota-notifications";

interface SettingsFiles {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(
    path: string,
    body: string,
    options: { encoding: "utf8"; flag: "wx"; mode: number },
  ): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
}

export interface SavedSettings {
  settings: Settings;
  bounds?: WindowBounds;
  notificationState?: NotificationState;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validBounds(value: unknown): value is WindowBounds {
  if (!record(value)) return false;
  return (
    ["x", "y", "width", "height"].every((key) =>
      Number.isSafeInteger(value[key]),
    ) &&
    Math.abs(value.x as number) <= 1_000_000 &&
    Math.abs(value.y as number) <= 1_000_000 &&
    (value.width as number) > 0 &&
    (value.width as number) <= 32_768 &&
    (value.height as number) > 0 &&
    (value.height as number) <= 32_768
  );
}

function copyBounds(bounds: WindowBounds): WindowBounds {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

function loadedSettings(input: unknown): Settings {
  const output = { ...DEFAULT_SETTINGS };
  if (!record(input)) return output;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const patch = { [key]: input[key] };
    if (isSettingsPatch(patch)) Object.assign(output, patch);
  }
  return output;
}

export class SettingsStore {
  #pending: Promise<void> = Promise.resolve();
  #path: string;
  #notificationState: NotificationState = [];

  constructor(
    private readonly directory: string,
    private readonly storage: SettingsFiles = files,
  ) {
    this.#path = join(directory, "preferences.json");
  }

  async load(): Promise<SavedSettings> {
    try {
      const body = await this.storage.readFile(this.#path, "utf8");
      if (body.length > 16_384) return { settings: { ...DEFAULT_SETTINGS } };
      const value: unknown = JSON.parse(body);
      if (!record(value)) return { settings: { ...DEFAULT_SETTINGS } };
      const result: SavedSettings = {
        settings: loadedSettings(value.settings),
      };
      if (validBounds(value.bounds)) result.bounds = copyBounds(value.bounds);
      this.#notificationState = validatedNotificationState(
        value.notificationState,
      );
      if (this.#notificationState.length)
        result.notificationState = [...this.#notificationState];
      return result;
    } catch {
      return { settings: { ...DEFAULT_SETTINGS } };
    }
  }

  async save(
    settings: Settings,
    bounds?: WindowBounds,
    notificationState?: NotificationState,
  ): Promise<void> {
    if (
      !isSettingsPatch(settings) ||
      Object.keys(DEFAULT_SETTINGS).some((key) => !Object.hasOwn(settings, key))
    )
      throw new Error("Invalid settings");
    if (bounds !== undefined && !validBounds(bounds))
      throw new Error("Invalid window bounds");
    const snapshot: SavedSettings = { settings: { ...settings } };
    if (bounds) snapshot.bounds = copyBounds(bounds);
    const proposed =
      notificationState === undefined
        ? undefined
        : validatedNotificationState(notificationState);
    const write = this.#pending
      .catch(() => {})
      .then(async () => {
        const state = proposed ?? this.#notificationState;
        if (state.length) snapshot.notificationState = [...state];
        const temporary = join(
          this.directory,
          "preferences-" + randomUUID() + ".tmp",
        );
        try {
          await this.storage.mkdir(this.directory, { recursive: true });
          await this.storage.writeFile(temporary, JSON.stringify(snapshot), {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          });
          await this.storage.rename(temporary, this.#path);
          this.#notificationState = state;
        } catch {
          throw new Error("Could not save preferences");
        } finally {
          await this.storage.rm(temporary, { force: true }).catch(() => {});
        }
      });
    this.#pending = write;
    return write;
  }

  flush(): Promise<void> {
    return this.#pending;
  }
}

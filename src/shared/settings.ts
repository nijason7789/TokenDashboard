export interface Settings {
  refreshInterval: 30 | 60 | 120 | 300;
  alwaysOnTop: boolean;
  compact: boolean;
  opacity: number;
  closeToTray: boolean;
  launchOnStartup: boolean;
  percentageMode: "remaining" | "used";
  lowQuotaNotification: boolean;
  lowQuotaThreshold: number;
}

export type SettingsPatch = Partial<Settings>;
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  refreshInterval: 60,
  alwaysOnTop: false,
  compact: false,
  opacity: 1,
  closeToTray: true,
  launchOnStartup: false,
  percentageMode: "remaining",
  lowQuotaNotification: false,
  lowQuotaThreshold: 20,
});

const boolean = (value: unknown) => typeof value === "boolean";
const validators: { [Key in keyof Settings]: (value: unknown) => boolean } = {
  refreshInterval: (value) =>
    value === 30 || value === 60 || value === 120 || value === 300,
  alwaysOnTop: boolean,
  compact: boolean,
  opacity: (value) => typeof value === "number" && value >= 0.5 && value <= 1,
  closeToTray: boolean,
  launchOnStartup: boolean,
  percentageMode: (value) => value === "remaining" || value === "used",
  lowQuotaNotification: boolean,
  lowQuotaThreshold: (value) =>
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 99,
};

export function isSettingsPatch(value: unknown): value is SettingsPatch {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null) &&
    Object.entries(value).every(
      ([key, field]) =>
        Object.hasOwn(validators, key) &&
        validators[key as keyof Settings](field),
    )
  );
}

export function isSettings(value: unknown): value is Settings {
  return (
    isSettingsPatch(value) &&
    Object.keys(DEFAULT_SETTINGS).every((key) => Object.hasOwn(value, key))
  );
}

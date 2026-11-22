import { useId } from "react";
import type { Settings, SettingsPatch } from "../shared/settings";

export function SettingsPanel({
  settings,
  saving,
  onChange,
  onClose,
}: {
  settings: Settings;
  saving: boolean;
  onChange: (patch: SettingsPatch) => void;
  onClose: () => void;
}) {
  const id = useId();
  const checks = [
    ["alwaysOnTop", "Always on top"],
    ["compact", "Compact mode"],
    ["closeToTray", "Close to tray"],
    ["launchOnStartup", "Launch on Windows startup"],
    ["lowQuotaNotification", "Low quota notifications"],
  ] as const;
  return (
    <section className="settings-panel" aria-labelledby={id}>
      <div className="settings-heading">
        <h2 id={id}>Settings</h2>
        <button type="button" onClick={onClose} aria-label="Close settings">
          Done
        </button>
      </div>
      <fieldset disabled={saving}>
        <label>
          Refresh interval
          <select
            value={settings.refreshInterval}
            onChange={(event) =>
              onChange({
                refreshInterval: Number(
                  event.currentTarget.value,
                ) as Settings["refreshInterval"],
              })
            }
          >
            {[30, 60, 120, 300].map((seconds) => (
              <option value={seconds} key={seconds}>
                {seconds} seconds
              </option>
            ))}
          </select>
        </label>
        <label>
          Show percentage
          <select
            value={settings.percentageMode}
            onChange={(event) =>
              onChange({
                percentageMode: event.currentTarget
                  .value as Settings["percentageMode"],
              })
            }
          >
            <option value="remaining">Remaining</option>
            <option value="used">Used</option>
          </select>
        </label>
        <label>
          Window opacity
          <span className="range-setting">
            <input
              type="range"
              min="0.5"
              max="1"
              step="0.05"
              value={settings.opacity}
              onChange={(event) =>
                onChange({ opacity: Number(event.currentTarget.value) })
              }
            />
            <output>{Math.round(settings.opacity * 100)}%</output>
          </span>
        </label>
        {checks.map(([key, label]) => (
          <label className="checkbox-setting" key={key}>
            <input
              type="checkbox"
              checked={settings[key]}
              onChange={(event) =>
                onChange({ [key]: event.currentTarget.checked })
              }
            />
            {label}
          </label>
        ))}
        <label>
          Low quota threshold
          <select
            value={settings.lowQuotaThreshold}
            onChange={(event) =>
              onChange({
                lowQuotaThreshold: Number(event.currentTarget.value),
              })
            }
          >
            {Array.from({ length: 99 }, (_, index) => index + 1).map(
              (value) => (
                <option value={value} key={value}>
                  {value}% remaining
                </option>
              ),
            )}
          </select>
        </label>
      </fieldset>
    </section>
  );
}

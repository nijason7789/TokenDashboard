import { useEffect, useId, useRef, useState } from "react";
import {
  resetCountdownMs,
  type QuotaApi,
  type QuotaDisplayWindow,
  type QuotaStatus,
} from "../shared/contract";
import { DEFAULT_SETTINGS, type SettingsPatch } from "../shared/settings";
import { SettingsPanel } from "./SettingsPanel";

const labels = {
  connected: "Connected",
  connecting: "Connecting",
  stale: "Stale",
  error: "Error",
  disconnected: "Disconnected",
  unavailable: "Quota source unavailable",
};
const percent = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
  roundingMode: "trunc",
});
const stamp = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function resetLabel(reset: number, now: number) {
  const minutes = Math.ceil((resetCountdownMs(reset, now) ?? 0) / 60000);
  if (!minutes) return "Awaiting quota refresh";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  return (
    "Resets in " +
    (days ? days + "d " : "") +
    (hours ? hours + "h " : "") +
    (minutes % 60) +
    "m"
  );
}

function QuotaCard({
  title,
  data,
  compact,
  now,
  percentageMode,
}: {
  title: string;
  data?: QuotaDisplayWindow;
  compact: boolean;
  now: number;
  percentageMode: "remaining" | "used";
}) {
  const id = useId();
  const remaining = data?.state === "available" ? data.remainingPercent : null;
  const reset = data?.state === "available" ? data.resetsAtMs : null;
  const value =
    remaining === null
      ? null
      : percentageMode === "used"
        ? 100 - remaining
        : remaining;
  const tone =
    remaining === null
      ? "neutral"
      : remaining >= 50
        ? "green"
        : remaining >= 20
          ? "yellow"
          : "red";
  return (
    <section className="quota-card" aria-labelledby={id}>
      <div className="quota-heading">
        <h2 id={id}>{title}</h2>
        {!compact && remaining !== null && (
          <span>
            {percent.format(
              percentageMode === "used" ? remaining : 100 - remaining,
            )}
            % {percentageMode === "used" ? "remaining" : "used"}
          </span>
        )}
      </div>
      <div className="quota-value" data-tone={tone}>
        <strong>{value === null ? "N/A" : percent.format(value) + "%"}</strong>
        {remaining !== null && <span>{percentageMode}</span>}
      </div>
      {remaining === null ? (
        <div className="meter" aria-hidden="true" />
      ) : (
        <progress
          className="meter"
          aria-label={title + " " + percentageMode}
          value={value ?? 0}
          max={100}
          data-tone={tone}
        />
      )}
      <div className="quota-meta">
        <span>
          {remaining === null
            ? data?.state === "ambiguous"
              ? "Ambiguous quota window"
              : "Quota window unavailable"
            : reset === null
              ? "Reset time unavailable"
              : resetLabel(reset, now)}
        </span>
        {!compact && reset !== null && (
          <time dateTime={new Date(reset).toISOString()}>
            Resets {stamp.format(reset)}
          </time>
        )}
      </div>
    </section>
  );
}

export function App({ api }: { api: QuotaApi }) {
  const [status, setStatus] = useState<QuotaStatus | null>(null);
  const [now, setNow] = useState(Date.now);
  const [settings, setSettings] = useState({ ...DEFAULT_SETTINGS });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsError, setSettingsError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [controlError, setControlError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pinning, setPinning] = useState(false);
  const epoch = useRef(0);
  const pending = useRef(false);
  const statusRevision = useRef(0);
  const settingsRevision = useRef(0);
  const settingsPending = useRef(false);
  const compact = settings.compact;
  const pinned = settings.alwaysOnTop;

  async function refresh() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    const token = epoch.current;
    const revision = statusRevision.current;
    try {
      const result = await api.getStatus();
      if (epoch.current === token && statusRevision.current === revision) {
        setStatus(result);
        setNow(Date.now());
      }
    } catch {
      if (epoch.current === token && statusRevision.current === revision)
        setStatus({ source: "unavailable" });
    } finally {
      if (epoch.current === token) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    const token = ++epoch.current;
    const offStatus = api.onStatusChanged((value) => {
      if (epoch.current !== token) return;
      statusRevision.current++;
      setStatus(value);
      setNow(Date.now());
    });
    const offSettings = api.onSettingsChanged((value) => {
      if (epoch.current !== token) return;
      settingsRevision.current++;
      setSettings(value);
    });
    const offOpenSettings = api.onOpenSettings(() => {
      if (epoch.current === token) setSettingsOpen(true);
    });
    const revision = settingsRevision.current;
    void refresh();
    void api.getSettings().then(
      (value) => {
        if (epoch.current === token && settingsRevision.current === revision)
          setSettings(value);
      },
      () => {
        if (epoch.current === token) setControlError(true);
      },
    );
    return () => {
      epoch.current++;
      pending.current = false;
      settingsPending.current = false;
      offStatus();
      offSettings();
      offOpenSettings();
    };
  }, [api]);

  const resets = [status?.fiveHour, status?.weekly].map((window) =>
    window?.state === "available" ? window.resetsAtMs : null,
  );
  const resetKey = resets.join(",");
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      if (!document.hidden) {
        const now = Date.now();
        setNow(now);
        const delays = resets.flatMap((reset) => {
          if (reset === null || reset <= now) return [];
          return [(reset - now) % 60000 || 60000];
        });
        if (delays.length) timer = setTimeout(update, Math.min(...delays));
      }
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [resetKey]);

  async function saveSettings(patch: SettingsPatch) {
    if (settingsPending.current) return;
    settingsPending.current = true;
    setSaving(true);
    setSettingsError(false);
    const token = epoch.current;
    const revision = ++settingsRevision.current;
    try {
      const result = await api.updateSettings(patch);
      if (epoch.current === token && settingsRevision.current === revision)
        setSettings(result);
    } catch {
      if (epoch.current === token) setSettingsError(true);
    } finally {
      if (epoch.current === token) {
        settingsPending.current = false;
        setSaving(false);
      }
    }
  }

  async function togglePin() {
    const token = epoch.current;
    const revision = ++settingsRevision.current;
    setPinning(true);
    setControlError(false);
    try {
      const value = await api.setAlwaysOnTop(!pinned);
      if (epoch.current === token && settingsRevision.current === revision)
        setSettings((current) => ({ ...current, alwaysOnTop: value }));
    } catch {
      if (epoch.current === token) setControlError(true);
    } finally {
      if (epoch.current === token) setPinning(false);
    }
  }

  const phase = !status
    ? "connecting"
    : status.source === "unavailable"
      ? "unavailable"
      : (status.phase ?? "unavailable");
  const modeName = compact ? "Normal mode" : "Compact mode";
  return (
    <main className={compact ? "dashboard compact" : "dashboard"}>
      <header className="titlebar">
        <div className="brand">
          <span className="mark" aria-hidden="true">
            ›_
          </span>
          <h1>Codex Quota Monitor</h1>
        </div>
        <div className="controls">
          <button
            aria-label="Refresh"
            title="Refresh"
            disabled={busy}
            onClick={() => void refresh()}
          >
            ↻
          </button>
          <button
            aria-label={modeName}
            title={modeName}
            aria-pressed={compact}
            disabled={saving}
            onClick={() => void saveSettings({ compact: !compact })}
          >
            ▤
          </button>
          <button
            aria-label="Settings"
            title="Settings"
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            ⚙
          </button>
          <button
            aria-label="Always on top"
            title="Always on top"
            aria-pressed={pinned}
            disabled={pinning}
            onClick={() => void togglePin()}
          >
            ↑
          </button>
          <button
            className="close"
            aria-label="Close window"
            title="Close window"
            onClick={() =>
              void api.closeWindow().catch(() => setControlError(true))
            }
          >
            ×
          </button>
        </div>
      </header>
      <div className="content">
        <div className="summary">
          <span role="status" className="status" data-phase={phase}>
            <span aria-hidden="true" className="dot" />
            {labels[phase]}
          </span>
          {status?.source === "mock" && (
            <span className="mock-label">Mock data</span>
          )}
        </div>
        <div className="quotas">
          <QuotaCard
            title="5-hour limit"
            data={status?.fiveHour}
            compact={compact}
            now={now}
            percentageMode={settings.percentageMode}
          />
          <QuotaCard
            title="Weekly limit"
            data={status?.weekly}
            compact={compact}
            now={now}
            percentageMode={settings.percentageMode}
          />
        </div>
        {status?.updatedAtMs !== undefined && (
          <footer>
            Last updated{" "}
            <time dateTime={new Date(status.updatedAtMs).toISOString()}>
              {stamp.format(status.updatedAtMs)}
            </time>
          </footer>
        )}
        {controlError && <p role="alert">Window control unavailable</p>}
        {settingsOpen && (
          <SettingsPanel
            settings={settings}
            saving={saving}
            onChange={(patch) => void saveSettings(patch)}
            onClose={() => setSettingsOpen(false)}
          />
        )}
        {settingsError && <p role="alert">Could not save settings</p>}
      </div>
    </main>
  );
}

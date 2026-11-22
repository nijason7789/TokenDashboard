import { useEffect, useId, useRef, useState } from "react";
import {
  resetCountdownMs,
  type QuotaApi,
  type QuotaDisplayWindow,
  type QuotaStatus,
} from "../shared/contract";

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
}: {
  title: string;
  data?: QuotaDisplayWindow;
  compact: boolean;
  now: number;
}) {
  const id = useId();
  const remaining = data?.state === "available" ? data.remainingPercent : null;
  const reset = data?.state === "available" ? data.resetsAtMs : null;
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
          <span>{percent.format(100 - remaining)}% used</span>
        )}
      </div>
      <div className="quota-value" data-tone={tone}>
        <strong>
          {remaining === null ? "N/A" : percent.format(remaining) + "%"}
        </strong>
        {remaining !== null && <span>remaining</span>}
      </div>
      {remaining === null ? (
        <div className="meter" aria-hidden="true" />
      ) : (
        <progress
          className="meter"
          aria-label={title + " remaining"}
          value={remaining}
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
  const [compact, setCompact] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [controlError, setControlError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pinning, setPinning] = useState(false);
  const epoch = useRef(0);
  const pending = useRef(false);

  async function refresh() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    const token = epoch.current;
    try {
      const result = await api.getStatus();
      if (epoch.current === token) {
        setStatus(result);
        setNow(Date.now());
      }
    } catch {
      if (epoch.current === token) setStatus({ source: "unavailable" });
    } finally {
      if (epoch.current === token) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    const token = ++epoch.current;
    void refresh();
    void api.getAlwaysOnTop().then(
      (value) => {
        if (epoch.current === token) setPinned(value);
      },
      () => {
        if (epoch.current === token) setControlError(true);
      },
    );
    return () => {
      epoch.current++;
      pending.current = false;
    };
  }, [api]);

  const hasCountdown = [status?.fiveHour, status?.weekly].some(
    (window) => window?.state === "available" && window.resetsAtMs !== null,
  );
  useEffect(() => {
    if (!hasCountdown) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const update = () => {
      clearInterval(timer);
      if (!document.hidden) {
        setNow(Date.now());
        timer = setInterval(() => setNow(Date.now()), 1000);
      }
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [hasCountdown]);

  async function togglePin() {
    const token = epoch.current;
    setPinning(true);
    setControlError(false);
    try {
      const value = await api.setAlwaysOnTop(!pinned);
      if (epoch.current === token) setPinned(value);
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
            onClick={() => setCompact(!compact)}
          >
            ▤
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
          />
          <QuotaCard
            title="Weekly limit"
            data={status?.weekly}
            compact={compact}
            now={now}
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
      </div>
    </main>
  );
}

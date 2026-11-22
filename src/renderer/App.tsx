import { useEffect, useState } from "react";
import type { QuotaApi, QuotaStatus } from "../shared/contract";

export function App({ api }: { api: QuotaApi }) {
  const [status, setStatus] = useState<QuotaStatus | null>(null);

  useEffect(() => {
    let mounted = true;

    async function load() {
      let result: QuotaStatus;
      try {
        result = await api.getStatus();
      } catch {
        result = { source: "unavailable" };
      }
      if (mounted) setStatus(result);
    }

    void load();
    return () => {
      mounted = false;
    };
  }, [api]);

  let message = "Checking quota source…";
  if (status?.source === "unavailable") message = "Quota source unavailable";
  if (status?.source === "mock")
    message = `Mock data · ${status.remaining}% remaining`;

  return (
    <main>
      <h1>Codex Quota Monitor</h1>
      <p role="status">{message}</p>
    </main>
  );
}

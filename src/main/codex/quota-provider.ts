import type { RunningCodex } from "./process";
import { CodexTransport } from "./transport";
import {
  QuotaProviderError,
  type QuotaProvider,
  type QuotaSession,
} from "../services/quota-provider";

export function createCodexQuotaProvider(
  launch: (signal: AbortSignal) => Promise<RunningCodex>,
): QuotaProvider {
  return {
    async open(signal) {
      if (signal.aborted) throw new QuotaProviderError("unavailable", true);
      let running: RunningCodex;
      try {
        running = await launch(signal);
      } catch (error) {
        if (error instanceof QuotaProviderError) throw error;
        throw new QuotaProviderError("trust", false);
      }

      let closed = false;
      let failed = false;
      let closing: Promise<void> | undefined;
      const listeners = new Set<{ update: () => void; failure: () => void }>();
      const fail = () => {
        if (closed || failed) return;
        failed = true;
        for (const listener of listeners) {
          try {
            listener.failure();
          } catch {
            /* Observers cannot prevent lifecycle cleanup. */
          }
        }
      };
      const transport = new CodexTransport(running.child, { onFailure: fail });
      const notificationFingerprints = new Map<string, string>();
      const unsubscribeTransport = transport.subscribeRateLimits((bucket) => {
        if (closed || failed) return;
        if (bucket.bucketId !== "codex" && bucket.bucketId !== "unidentified")
          return;
        const fingerprint = JSON.stringify(bucket);
        if (notificationFingerprints.get(bucket.bucketId) === fingerprint)
          return;
        notificationFingerprints.set(bucket.bucketId, fingerprint);
        for (const listener of listeners) {
          try {
            listener.update();
          } catch {
            /* Isolate observer exceptions. */
          }
        }
      });

      const session: QuotaSession = {
        async read() {
          if (closed || failed || signal.aborted)
            throw new QuotaProviderError("transport", true);
          try {
            return await transport.readRateLimits();
          } catch {
            fail();
            throw new QuotaProviderError("transport", true);
          }
        },
        subscribe(update, failure) {
          if (closed || failed || listeners.size >= 16)
            throw new QuotaProviderError("transport", true);
          const listener = { update, failure };
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        close() {
          if (closing) return closing;
          closed = true;
          signal.removeEventListener("abort", abort);
          unsubscribeTransport();
          notificationFingerprints.clear();
          listeners.clear();
          transport.close();
          closing = Promise.resolve()
            .then(() => running.shutdown())
            .catch(() => {
              throw new QuotaProviderError("cleanup", false);
            });
          return closing;
        },
      };
      const abort = () => {
        // close remains awaitable by the monitor, including any cleanup failure.
        void session.close().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted) throw new QuotaProviderError("unavailable", true);
        await transport.initialize();
        const account = await transport.readAccount();
        if (account !== "chatgpt") throw new QuotaProviderError(account, false);
        if (signal.aborted || failed)
          throw new QuotaProviderError("transport", true);
        return session;
      } catch (error) {
        await session.close();
        if (error instanceof QuotaProviderError) throw error;
        throw new QuotaProviderError("transport", true);
      }
    },
  };
}

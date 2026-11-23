import type { RunningCodex } from "./process";
import {
  interruptStartup,
  startupDeadline,
  startupLimits,
} from "./startup-deadline";
import { CodexTransport } from "./transport";
import {
  QuotaProviderError,
  type QuotaProvider,
  type QuotaSession,
} from "../services/quota-provider";

export function createCodexQuotaProvider(
  launch: (signal: AbortSignal) => Promise<RunningCodex>,
): QuotaProvider {
  let quarantined = false;
  let starting = false;
  return {
    async open(signal) {
      if (quarantined) throw new QuotaProviderError("cleanup", false);
      if (starting || signal.aborted)
        throw new QuotaProviderError("unavailable", true);
      starting = true;
      const startup = startupDeadline(signal, startupLimits.overall);
      try {
        return await open(signal, startup.signal);
      } catch (error) {
        if (error instanceof QuotaProviderError && error.reason === "cleanup") {
          quarantined = true;
        }
        throw error;
      } finally {
        startup.clear();
        starting = false;
      }
    },
  };

  async function open(
    signal: AbortSignal,
    startup: AbortSignal,
  ): Promise<QuotaSession> {
    const opening = (async () => launch(startup))();
    let running: RunningCodex;
    try {
      running = await interruptStartup(opening, startup);
    } catch (error) {
      if (startup.aborted) {
        // Keep ownership of a late launcher result even if cleanup cannot be confirmed in time.
        const cleanup = opening.then(
          (child) => child.shutdown(),
          (failure: unknown) => {
            if (
              failure instanceof QuotaProviderError &&
              failure.reason === "cleanup"
            )
              throw failure;
          },
        );
        const grace = startupDeadline(
          new AbortController().signal,
          startupLimits.cleanup,
        );
        try {
          await interruptStartup(cleanup, grace.signal);
        } catch {
          throw new QuotaProviderError("cleanup", false);
        } finally {
          grace.clear();
        }
        startup.throwIfAborted();
      }
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
      if (notificationFingerprints.get(bucket.bucketId) === fingerprint) return;
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
    const handshake = startupDeadline(startup, startupLimits.handshake);
    handshake.signal.addEventListener("abort", abort, { once: true });
    try {
      handshake.signal.throwIfAborted();
      await transport.initialize();
      handshake.signal.throwIfAborted();
      const account = await transport.readAccount();
      handshake.signal.throwIfAborted();
      if (account !== "chatgpt") throw new QuotaProviderError(account, false);
      if (signal.aborted || failed)
        throw new QuotaProviderError("transport", true);
      return session;
    } catch (error) {
      await session.close();
      handshake.signal.throwIfAborted();
      if (error instanceof QuotaProviderError) throw error;
      throw new QuotaProviderError("transport", true);
    } finally {
      handshake.signal.removeEventListener("abort", abort);
      handshake.clear();
    }
  }
}

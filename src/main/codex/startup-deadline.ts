import { QuotaProviderError } from "../services/quota-provider";

export function startupDeadline(parent: AbortSignal, ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new QuotaProviderError("timeout", true)),
    ms,
  );
  return {
    signal: AbortSignal.any([parent, controller.signal]),
    clear: () => clearTimeout(timer),
  };
}

export async function interruptStartup<T>(
  work: Promise<T>,
  signal: AbortSignal,
) {
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([work, interrupted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

import type { QuotaSnapshot } from "../codex/rate-limits";

export type QuotaFailure =
  | "unauthenticated"
  | "unsupported"
  | "trust"
  | "unavailable"
  | "cleanup"
  | "timeout"
  | "transport";

export class QuotaProviderError extends Error {
  constructor(
    readonly reason: QuotaFailure,
    readonly retryable: boolean,
  ) {
    super(reason);
  }
}

export interface QuotaSession {
  read(): Promise<QuotaSnapshot>;
  subscribe(onUpdate: () => void, onFailure: () => void): () => void;
  // Resolve only after the provider has canceled outstanding work and released the session.
  close(): Promise<void>;
}

export interface QuotaProvider {
  // An aborted open must settle after releasing any partial session, or return a session
  // the monitor can close. A replacement cannot open until that ownership is resolved.
  open(signal: AbortSignal): Promise<QuotaSession>;
}

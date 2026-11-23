export const quotaTiming = {
  read: 10_000,
  startup: 30_000,
  startupCleanup: 16_000,
  startupCleanupMargin: 1_000,
  windows: 20_000,
  spawn: 5_000,
  verifierExchange: 10_000,
  shutdownGrace: 250,
  childTermination: 5_000,
  verifierTermination: 10_000,
  handshake: 10_000,
} as const;

// Only the consumed transport fields enter this DTO. Other server metadata is discarded.
type WindowDto = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

type SnapshotDto = {
  limitId: string | null;
  primary: WindowDto | null;
  secondary: WindowDto | null;
};

export type QuotaWindow = {
  kind: "five-hour" | "weekly" | "unknown";
  durationMinutes: number | null;
  usedPercent: number;
  remainingPercent: number;
  resetsAtMs: number | null;
};

type WindowSelection =
  | { state: "available"; window: QuotaWindow }
  | { state: "missing" | "ambiguous" };

export type QuotaBucket = {
  bucketId: string;
  source: "map" | "legacy" | "notification";
  windows: QuotaWindow[];
  fiveHour: WindowSelection;
  weekly: WindowSelection;
};

export type QuotaSnapshot = {
  buckets: QuotaBucket[];
  defaultSelection:
    | { state: "selected"; bucketId: string }
    | { state: "missing" | "ambiguous" };
};

function invalid(): never {
  throw new Error("Invalid rate limit data");
}

function object(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    invalid();
  return input as Record<string, unknown>;
}

function identifier(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 128)
    invalid();
  return input;
}

function decodeWindow(input: unknown): WindowDto | null {
  if (input === null) return null;
  const value = object(input);
  const used = value.usedPercent;
  if (
    typeof used !== "number" ||
    !Number.isFinite(used) ||
    used < 0 ||
    used > 100
  )
    invalid();
  const duration = value.windowDurationMins;
  if (
    duration !== null &&
    (typeof duration !== "number" ||
      !Number.isSafeInteger(duration) ||
      duration <= 0)
  )
    invalid();
  const reset = value.resetsAt;
  // Bound Unix seconds to year 9999. Millisecond timestamps fail this contract.
  if (
    reset !== null &&
    (typeof reset !== "number" ||
      !Number.isSafeInteger(reset) ||
      reset < 0 ||
      reset > 253_402_300_799)
  )
    invalid();
  return { usedPercent: used, windowDurationMins: duration, resetsAt: reset };
}

function decodeSnapshot(input: unknown, sparse: boolean): SnapshotDto {
  const value = object(input);
  const limitId = sparse && value.limitId === undefined ? null : value.limitId;
  return {
    limitId: limitId === null ? null : identifier(limitId),
    primary: decodeWindow(
      sparse && value.primary === undefined ? null : value.primary,
    ),
    secondary: decodeWindow(
      sparse && value.secondary === undefined ? null : value.secondary,
    ),
  };
}

function selectWindow(
  windows: QuotaWindow[],
  kind: QuotaWindow["kind"],
): WindowSelection {
  const matching = windows.filter((window) => window.kind === kind);
  if (matching.length === 0) return { state: "missing" };
  if (matching.length > 1) return { state: "ambiguous" };
  return { state: "available", window: matching[0]! };
}

function normalize(
  dto: SnapshotDto,
  bucketId: string,
  source: QuotaBucket["source"],
): QuotaBucket {
  const windows: QuotaWindow[] = [];
  for (const value of [dto.primary, dto.secondary]) {
    if (value === null) continue;
    let kind: QuotaWindow["kind"] = "unknown";
    if (value.windowDurationMins === 300) kind = "five-hour";
    if (value.windowDurationMins === 10080) kind = "weekly";
    windows.push({
      kind,
      durationMinutes: value.windowDurationMins,
      usedPercent: value.usedPercent,
      remainingPercent: 100 - value.usedPercent,
      resetsAtMs: value.resetsAt === null ? null : value.resetsAt * 1000,
    });
  }
  return {
    bucketId,
    source,
    windows,
    fiveHour: selectWindow(windows, "five-hour"),
    weekly: selectWindow(windows, "weekly"),
  };
}

export function parseRateLimitsResponse(input: unknown): QuotaSnapshot {
  const value = object(input);
  const legacy = decodeSnapshot(value.rateLimits, false);
  if (
    value.rateLimitsByLimitId === null ||
    value.rateLimitsByLimitId === undefined
  ) {
    const bucket = normalize(legacy, legacy.limitId ?? "legacy", "legacy");
    let defaultSelection: QuotaSnapshot["defaultSelection"] = {
      state: "ambiguous",
    };
    if (legacy.limitId === null || legacy.limitId === "codex")
      defaultSelection = { state: "selected", bucketId: bucket.bucketId };
    return { buckets: [bucket], defaultSelection };
  }

  const entries = Object.entries(object(value.rateLimitsByLimitId));
  if (entries.length > 64) invalid();
  const buckets = entries
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, snapshot]) => {
      const bucketId = identifier(key);
      const dto = decodeSnapshot(snapshot, false);
      if (dto.limitId !== null && dto.limitId !== bucketId) invalid();
      return normalize(dto, bucketId, "map");
    });
  if (buckets.some((bucket) => bucket.bucketId === "codex")) {
    return {
      buckets,
      defaultSelection: { state: "selected", bucketId: "codex" },
    };
  }
  return {
    buckets,
    defaultSelection: { state: buckets.length === 0 ? "missing" : "ambiguous" },
  };
}

export function parseRateLimitsNotification(input: unknown): QuotaBucket {
  const value = object(object(input).rateLimits);
  if (
    !["limitId", "primary", "secondary"].some((key) =>
      Object.hasOwn(value, key),
    )
  )
    invalid();
  const dto = decodeSnapshot(value, true);
  return normalize(dto, dto.limitId ?? "unidentified", "notification");
}

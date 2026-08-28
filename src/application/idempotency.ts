import { createHash } from "node:crypto";

import type { IdempotencyRecord } from "@/src/repositories/session-repository";

export class IdempotencyKeyReusedError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED";

  constructor() {
    super("IDEMPOTENCY_KEY_REUSED");
    this.name = "IdempotencyKeyReusedError";
  }
}

export class IdempotencyInProgressError extends Error {
  readonly code = "IDEMPOTENCY_IN_PROGRESS";

  constructor() {
    super("IDEMPOTENCY_IN_PROGRESS");
    this.name = "IdempotencyInProgressError";
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;

    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }

  return value;
}

export function fingerprintRequest(value: unknown): string {
  const canonical = JSON.stringify(canonicalize(value)) ?? "null";

  return createHash("sha256").update(canonical).digest("hex");
}

export function assertIdempotencyFingerprint(
  record: IdempotencyRecord,
  requestFingerprint: string,
): void {
  if (record.requestFingerprint !== requestFingerprint) {
    throw new IdempotencyKeyReusedError();
  }
}

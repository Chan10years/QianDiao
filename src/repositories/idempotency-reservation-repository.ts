import type {
  IdempotencyRecord,
  SaveIdempotencyRecordInput,
} from "@/src/repositories/session-repository";

export interface AcquireIdempotencyLeaseInput {
  id: string;
  sessionId: string;
  requestId: string;
  requestFingerprint: string;
  expectedVersion: number;
  response: Record<string, unknown>;
  statusCode: number;
  leaseOwner: string;
  leaseExpiresAt: Date;
  now: Date;
}

export type IdempotencyLeaseAcquisition =
  | { status: "acquired"; record: IdempotencyRecord }
  | { status: "busy"; record: IdempotencyRecord }
  | { status: "completed"; record: IdempotencyRecord }
  | { status: "conflict"; record: IdempotencyRecord };

export interface AssertIdempotencyLeaseInput {
  requestId: string;
  expectedVersion: number;
  leaseOwner: string;
  now: Date;
}

export interface RenewIdempotencyLeaseInput {
  requestId: string;
  expectedVersion: number;
  leaseOwner: string;
  leaseExpiresAt: Date;
  now: Date;
}

export interface CompleteIdempotencyRecordInput {
  requestId: string;
  leaseOwner: string;
  now: Date;
  response: Record<string, unknown>;
  statusCode: number;
}

export interface DeleteIdempotencyRecordInput {
  requestId: string;
  leaseOwner: string;
  now: Date;
}

export class IdempotencyLeaseLostError extends Error {
  readonly code = "IDEMPOTENCY_LEASE_LOST";

  constructor() {
    super("IDEMPOTENCY_LEASE_LOST");
    this.name = "IdempotencyLeaseLostError";
  }
}

export class IdempotencyReservationCleanupError extends Error {
  readonly code = "IDEMPOTENCY_CLEANUP_FAILED";

  constructor(cause: unknown) {
    super("IDEMPOTENCY_CLEANUP_FAILED", { cause });
    this.name = "IdempotencyReservationCleanupError";
  }
}

export interface IdempotencyReservationRepository {
  acquireIdempotencyLease(input: AcquireIdempotencyLeaseInput): IdempotencyLeaseAcquisition;
  assertIdempotencyLease(input: AssertIdempotencyLeaseInput): void;
  renewIdempotencyLease(input: RenewIdempotencyLeaseInput): void;
  completeIdempotencyRecord(input: CompleteIdempotencyRecordInput): IdempotencyRecord;
  deleteIdempotencyRecord(input: DeleteIdempotencyRecordInput): void;
  saveIdempotencyRecord(input: SaveIdempotencyRecordInput): IdempotencyRecord;
}

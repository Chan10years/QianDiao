import type { TasteProfile } from "@/src/domain/preferences";
import type { SessionState } from "@/src/domain/session";

export interface SessionRecord {
  id: string;
  state: SessionState;
  version: number;
  preferences: TasteProfile | null;
  selectedRecipeId: string | null;
  currentStep: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSessionInput {
  id: string;
}

export interface UpdateSessionVersionInput {
  id: string;
  expectedVersion: number;
  leaseOwner: string;
  leaseNow?: Date;
  state?: SessionState;
  preferences?: TasteProfile | null;
  selectedRecipeId?: string | null;
  currentStep?: number | null;
}

export interface IdempotencyRecord {
  id: string;
  sessionId: string;
  requestId: string;
  requestFingerprint: string;
  response: Record<string, unknown>;
  statusCode: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  createdAt: Date;
}

export interface SaveIdempotencyRecordInput {
  id: string;
  sessionId: string;
  requestId: string;
  requestFingerprint: string;
  response: Record<string, unknown>;
  statusCode: number;
  leaseOwner?: string | null;
  leaseExpiresAt?: Date | null;
}

export interface AcquireSessionMutationLeaseInput {
  sessionId: string;
  requestId: string;
  expectedVersion: number;
  leaseOwner: string;
  leaseExpiresAt: Date;
  now: Date;
}

export type SessionMutationLeaseAcquisition =
  | { status: "acquired"; session: SessionRecord }
  | { status: "busy"; session: SessionRecord }
  | { status: "version-conflict"; session: SessionRecord };

export interface AssertSessionMutationLeaseInput {
  sessionId: string;
  expectedVersion: number;
  leaseOwner: string;
  now: Date;
}

export interface RenewSessionMutationLeaseInput {
  sessionId: string;
  expectedVersion: number;
  leaseOwner: string;
  leaseExpiresAt: Date;
  now: Date;
}

export interface ReleaseSessionMutationLeaseInput {
  sessionId: string;
  leaseOwner: string;
  now: Date;
}

export interface SessionMutationLeaseRepository {
  acquireSessionMutationLease(
    input: AcquireSessionMutationLeaseInput,
  ): SessionMutationLeaseAcquisition;
  assertSessionMutationLease(input: AssertSessionMutationLeaseInput): void;
  renewSessionMutationLease(input: RenewSessionMutationLeaseInput): void;
  releaseSessionMutationLease(input: ReleaseSessionMutationLeaseInput): void;
}

export interface SessionRepository {
  create(input: CreateSessionInput): SessionRecord;
  findById(id: string): SessionRecord | null;
  updateVersion(input: UpdateSessionVersionInput): SessionRecord;
  saveIdempotencyRecord(input: SaveIdempotencyRecordInput): IdempotencyRecord;
  findIdempotencyRecord(sessionId: string, requestId: string): IdempotencyRecord | null;
  findIdempotencyRecordByRequestId(requestId: string): IdempotencyRecord | null;
}

export class SessionVersionConflictError extends Error {
  readonly code = "SESSION_VERSION_CONFLICT";

  constructor() {
    super("SESSION_VERSION_CONFLICT");
    this.name = "SessionVersionConflictError";
  }
}

export class SessionNotFoundError extends Error {
  readonly code = "SESSION_NOT_FOUND";

  constructor() {
    super("SESSION_NOT_FOUND");
    this.name = "SessionNotFoundError";
  }
}

export class SessionMutationInProgressError extends Error {
  readonly code = "SESSION_MUTATION_IN_PROGRESS";

  constructor() {
    super("SESSION_MUTATION_IN_PROGRESS");
    this.name = "SessionMutationInProgressError";
  }
}

export class SessionMutationLeaseLostError extends Error {
  readonly code = "SESSION_MUTATION_LEASE_LOST";

  constructor() {
    super("SESSION_MUTATION_LEASE_LOST");
    this.name = "SessionMutationLeaseLostError";
  }
}

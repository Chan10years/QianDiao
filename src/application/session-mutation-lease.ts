import type { SessionMutationLeaseRepository } from "@/src/repositories/session-repository";
import {
  SessionMutationInProgressError,
  SessionVersionConflictError,
} from "@/src/repositories/session-repository";

export const SESSION_MUTATION_LEASE_DURATION_MS = 15_000;

export function acquireSessionMutationLease(
  repository: SessionMutationLeaseRepository,
  input: {
    sessionId: string;
    requestId: string;
    expectedVersion: number;
    leaseOwner: string;
    now?: Date;
    leaseDurationMs?: number;
  },
): void {
  const now = input.now ?? new Date();
  const acquisition = repository.acquireSessionMutationLease({
    sessionId: input.sessionId,
    requestId: input.requestId,
    expectedVersion: input.expectedVersion,
    leaseOwner: input.leaseOwner,
    leaseExpiresAt: new Date(
      now.getTime() + (input.leaseDurationMs ?? SESSION_MUTATION_LEASE_DURATION_MS),
    ),
    now,
  });

  if (acquisition.status === "version-conflict") {
    throw new SessionVersionConflictError();
  }
  if (acquisition.status === "busy") {
    throw new SessionMutationInProgressError();
  }
}

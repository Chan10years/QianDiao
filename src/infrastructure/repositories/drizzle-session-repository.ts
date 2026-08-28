import { randomUUID } from "node:crypto";

import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";

import { TasteProfileSchema } from "@/src/domain/preferences";
import { SessionStateSchema } from "@/src/domain/session";
import type { DatabaseExecutor } from "@/src/infrastructure/db/transaction";
import {
  idempotencyRecords,
  sessionMutationLeases,
  sessions,
} from "@/src/infrastructure/db/schema";
import {
  IdempotencyLeaseLostError as LeaseLostError,
  type AcquireIdempotencyLeaseInput,
  type AssertIdempotencyLeaseInput,
  type CompleteIdempotencyRecordInput,
  type DeleteIdempotencyRecordInput,
  type IdempotencyLeaseAcquisition,
  type IdempotencyReservationRepository,
  type RenewIdempotencyLeaseInput,
} from "@/src/repositories/idempotency-reservation-repository";
import {
  SessionMutationInProgressError,
  SessionMutationLeaseLostError,
  SessionNotFoundError,
  SessionVersionConflictError,
  type AcquireSessionMutationLeaseInput,
  type AssertSessionMutationLeaseInput,
  type CreateSessionInput,
  type IdempotencyRecord,
  type RenewSessionMutationLeaseInput,
  type ReleaseSessionMutationLeaseInput,
  type SaveIdempotencyRecordInput,
  type SessionMutationLeaseAcquisition,
  type SessionMutationLeaseRepository,
  type SessionRecord,
  type SessionRepository,
  type UpdateSessionVersionInput,
} from "@/src/repositories/session-repository";

const IdempotencyResponseSchema = z.record(z.string(), z.unknown());
const PENDING_IDEMPOTENCY_STATUS_CODE = 102;

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function toSessionRecord(row: typeof sessions.$inferSelect): SessionRecord {
  return {
    id: row.id,
    state: SessionStateSchema.parse(row.state),
    version: row.version,
    preferences:
      row.preferencesJson === null
        ? null
        : TasteProfileSchema.parse(parseJson(row.preferencesJson)),
    selectedRecipeId: row.selectedRecipeId,
    currentStep: row.currentStep,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toIdempotencyRecord(row: typeof idempotencyRecords.$inferSelect): IdempotencyRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    requestId: row.requestId,
    requestFingerprint: row.requestFingerprint,
    response: IdempotencyResponseSchema.parse(parseJson(row.responseJson)),
    statusCode: row.statusCode,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt,
    createdAt: row.createdAt,
  };
}

export class DrizzleSessionRepository
  implements SessionRepository, SessionMutationLeaseRepository, IdempotencyReservationRepository
{
  constructor(private readonly database: DatabaseExecutor) {}

  create(input: CreateSessionInput): SessionRecord {
    this.database.insert(sessions).values({ id: input.id }).run();
    const created = this.findById(input.id);
    if (created === null) {
      throw new Error("SESSION_CREATE_FAILED");
    }
    return created;
  }

  findById(id: string): SessionRecord | null {
    const row = this.database.select().from(sessions).where(eq(sessions.id, id)).get();
    return row === undefined ? null : toSessionRecord(row);
  }

  updateVersion(input: UpdateSessionVersionInput): SessionRecord {
    const leaseNow = input.leaseNow ?? new Date();
    this.assertSessionMutationLease({
      sessionId: input.id,
      expectedVersion: input.expectedVersion,
      leaseOwner: input.leaseOwner,
      now: leaseNow,
    });

    const updateValues = {
      version: sql`${sessions.version} + 1`,
      updatedAt: new Date(),
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.preferences === undefined
        ? {}
        : {
            preferencesJson:
              input.preferences === null
                ? null
                : JSON.stringify(TasteProfileSchema.parse(input.preferences)),
          }),
      ...(input.selectedRecipeId === undefined ? {} : { selectedRecipeId: input.selectedRecipeId }),
      ...(input.currentStep === undefined ? {} : { currentStep: input.currentStep }),
    };

    const result = this.database
      .update(sessions)
      .set(updateValues)
      .where(and(eq(sessions.id, input.id), eq(sessions.version, input.expectedVersion)))
      .run();

    if (result.changes === 0) {
      if (this.findById(input.id) === null) {
        throw new SessionNotFoundError();
      }
      throw new SessionVersionConflictError();
    }

    const updated = this.findById(input.id);
    if (updated === null) {
      throw new SessionNotFoundError();
    }
    return updated;
  }

  acquireSessionMutationLease(
    input: AcquireSessionMutationLeaseInput,
  ): SessionMutationLeaseAcquisition {
    let session = this.findById(input.sessionId);
    if (session === null) {
      throw new SessionNotFoundError();
    }
    if (session.version !== input.expectedVersion) {
      return { status: "version-conflict", session };
    }

    const inserted = this.database
      .insert(sessionMutationLeases)
      .values({
        sessionId: input.sessionId,
        requestId: input.requestId,
        expectedVersion: input.expectedVersion,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.leaseExpiresAt,
      })
      .onConflictDoNothing()
      .run();

    if (inserted.changes > 0) {
      return { status: "acquired", session };
    }

    const current = this.database
      .select()
      .from(sessionMutationLeases)
      .where(
        or(
          eq(sessionMutationLeases.sessionId, input.sessionId),
          eq(sessionMutationLeases.requestId, input.requestId),
        ),
      )
      .get();

    if (current === undefined || current.leaseExpiresAt.getTime() > input.now.getTime()) {
      return { status: "busy", session };
    }

    session = this.findById(input.sessionId);
    if (session === null) {
      throw new SessionNotFoundError();
    }
    if (session.version !== input.expectedVersion) {
      return { status: "version-conflict", session };
    }

    const taken = this.database
      .update(sessionMutationLeases)
      .set({
        requestId: input.requestId,
        expectedVersion: input.expectedVersion,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.leaseExpiresAt,
      })
      .where(
        and(
          eq(sessionMutationLeases.sessionId, input.sessionId),
          lte(sessionMutationLeases.leaseExpiresAt, input.now),
        ),
      )
      .run();

    if (taken.changes > 0) {
      return { status: "acquired", session };
    }

    return { status: "busy", session };
  }

  assertSessionMutationLease(input: AssertSessionMutationLeaseInput): void {
    const current = this.database
      .select()
      .from(sessionMutationLeases)
      .where(eq(sessionMutationLeases.sessionId, input.sessionId))
      .get();

    if (
      current === undefined ||
      current.expectedVersion !== input.expectedVersion ||
      current.leaseOwner !== input.leaseOwner ||
      current.leaseExpiresAt.getTime() <= input.now.getTime()
    ) {
      throw new SessionMutationLeaseLostError();
    }
  }

  renewSessionMutationLease(input: RenewSessionMutationLeaseInput): void {
    const current = this.database
      .select({
        leaseExpiresAt: sessionMutationLeases.leaseExpiresAt,
      })
      .from(sessionMutationLeases)
      .where(
        and(
          eq(sessionMutationLeases.sessionId, input.sessionId),
          eq(sessionMutationLeases.expectedVersion, input.expectedVersion),
          eq(sessionMutationLeases.leaseOwner, input.leaseOwner),
          gt(sessionMutationLeases.leaseExpiresAt, input.now),
        ),
      )
      .get();

    if (current === undefined) {
      throw new SessionMutationLeaseLostError();
    }

    const nextLeaseExpiresAt =
      current.leaseExpiresAt.getTime() > input.leaseExpiresAt.getTime()
        ? current.leaseExpiresAt
        : input.leaseExpiresAt;

    const result = this.database
      .update(sessionMutationLeases)
      .set({
        leaseExpiresAt: nextLeaseExpiresAt,
      })
      .where(
        and(
          eq(sessionMutationLeases.sessionId, input.sessionId),
          eq(sessionMutationLeases.expectedVersion, input.expectedVersion),
          eq(sessionMutationLeases.leaseOwner, input.leaseOwner),
          gt(sessionMutationLeases.leaseExpiresAt, input.now),
        ),
      )
      .run();

    if (result.changes === 0) {
      throw new SessionMutationLeaseLostError();
    }
  }

  releaseSessionMutationLease(input: ReleaseSessionMutationLeaseInput): void {
    const result = this.database
      .delete(sessionMutationLeases)
      .where(
        and(
          eq(sessionMutationLeases.sessionId, input.sessionId),
          eq(sessionMutationLeases.leaseOwner, input.leaseOwner),
          gt(sessionMutationLeases.leaseExpiresAt, input.now),
        ),
      )
      .run();

    if (result.changes === 0) {
      throw new SessionMutationLeaseLostError();
    }
  }

  saveIdempotencyRecord(input: SaveIdempotencyRecordInput): IdempotencyRecord {
    const response = IdempotencyResponseSchema.parse(input.response);
    this.database
      .insert(idempotencyRecords)
      .values({
        id: input.id || randomUUID(),
        sessionId: input.sessionId,
        requestId: input.requestId,
        requestFingerprint: input.requestFingerprint,
        responseJson: JSON.stringify(response),
        statusCode: input.statusCode,
        leaseOwner: input.leaseOwner ?? null,
        leaseExpiresAt: input.leaseExpiresAt ?? null,
      })
      .run();

    const saved = this.findIdempotencyRecord(input.sessionId, input.requestId);
    if (saved === null) {
      throw new Error("IDEMPOTENCY_RECORD_CREATE_FAILED");
    }
    return saved;
  }

  acquireIdempotencyLease(input: AcquireIdempotencyLeaseInput): IdempotencyLeaseAcquisition {
    const response = IdempotencyResponseSchema.parse(input.response);
    let current = this.findIdempotencyRecordByRequestId(input.requestId);

    if (current === null) {
      this.acquireSessionLeaseForIdempotency(input);
      const inserted = this.database
        .insert(idempotencyRecords)
        .values({
          id: input.id || randomUUID(),
          sessionId: input.sessionId,
          requestId: input.requestId,
          requestFingerprint: input.requestFingerprint,
          responseJson: JSON.stringify(response),
          statusCode: input.statusCode,
          leaseOwner: input.leaseOwner,
          leaseExpiresAt: input.leaseExpiresAt,
        })
        .onConflictDoNothing({ target: idempotencyRecords.requestId })
        .run();

      if (inserted.changes === 0) {
        throw new SessionMutationInProgressError();
      }

      current = this.findIdempotencyRecordByRequestId(input.requestId);
      if (current === null) {
        throw new Error("IDEMPOTENCY_RECORD_ACQUIRE_FAILED");
      }
      return { status: "acquired", record: current };
    }

    if (current.requestFingerprint !== input.requestFingerprint) {
      return { status: "conflict", record: current };
    }
    if (current.statusCode !== PENDING_IDEMPOTENCY_STATUS_CODE) {
      return { status: "completed", record: current };
    }

    const leaseIsActive =
      current.leaseOwner !== null &&
      current.leaseExpiresAt !== null &&
      current.leaseExpiresAt.getTime() > input.now.getTime();
    if (leaseIsActive) {
      return { status: "busy", record: current };
    }

    this.acquireSessionLeaseForIdempotency(input);

    const taken = this.database
      .update(idempotencyRecords)
      .set({
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.leaseExpiresAt,
      })
      .where(
        and(
          eq(idempotencyRecords.requestId, input.requestId),
          eq(idempotencyRecords.requestFingerprint, input.requestFingerprint),
          eq(idempotencyRecords.statusCode, PENDING_IDEMPOTENCY_STATUS_CODE),
          or(
            isNull(idempotencyRecords.leaseOwner),
            isNull(idempotencyRecords.leaseExpiresAt),
            lte(idempotencyRecords.leaseExpiresAt, input.now),
          ),
        ),
      )
      .run();

    if (taken.changes === 0) {
      throw new SessionMutationInProgressError();
    }

    current = this.findIdempotencyRecordByRequestId(input.requestId);
    if (current === null) {
      throw new Error("IDEMPOTENCY_RECORD_ACQUIRE_FAILED");
    }
    return { status: "acquired", record: current };
  }

  assertIdempotencyLease(input: AssertIdempotencyLeaseInput): void {
    const current = this.findIdempotencyRecordByRequestId(input.requestId);
    if (
      current === null ||
      current.statusCode !== PENDING_IDEMPOTENCY_STATUS_CODE ||
      current.leaseOwner !== input.leaseOwner ||
      current.leaseExpiresAt === null ||
      current.leaseExpiresAt.getTime() <= input.now.getTime()
    ) {
      throw new LeaseLostError();
    }

    this.assertSessionMutationLease({
      sessionId: current.sessionId,
      expectedVersion: input.expectedVersion,
      leaseOwner: input.leaseOwner,
      now: input.now,
    });
  }

  renewIdempotencyLease(input: RenewIdempotencyLeaseInput): void {
    const current = this.findIdempotencyRecordByRequestId(input.requestId);
    if (
      current === null ||
      current.statusCode !== PENDING_IDEMPOTENCY_STATUS_CODE ||
      current.leaseOwner !== input.leaseOwner ||
      current.leaseExpiresAt === null ||
      current.leaseExpiresAt.getTime() <= input.now.getTime()
    ) {
      throw new LeaseLostError();
    }

    const nextLeaseExpiresAt =
      current.leaseExpiresAt.getTime() > input.leaseExpiresAt.getTime()
        ? current.leaseExpiresAt
        : input.leaseExpiresAt;

    this.renewSessionMutationLease({
      sessionId: current.sessionId,
      expectedVersion: input.expectedVersion,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: input.leaseExpiresAt,
      now: input.now,
    });

    const result = this.database
      .update(idempotencyRecords)
      .set({
        leaseExpiresAt: nextLeaseExpiresAt,
      })
      .where(
        and(
          eq(idempotencyRecords.requestId, input.requestId),
          eq(idempotencyRecords.statusCode, PENDING_IDEMPOTENCY_STATUS_CODE),
          eq(idempotencyRecords.leaseOwner, input.leaseOwner),
          gt(idempotencyRecords.leaseExpiresAt, input.now),
        ),
      )
      .run();

    if (result.changes === 0) {
      throw new LeaseLostError();
    }
  }

  completeIdempotencyRecord(input: CompleteIdempotencyRecordInput): IdempotencyRecord {
    const response = IdempotencyResponseSchema.parse(input.response);
    const current = this.findIdempotencyRecordByRequestId(input.requestId);
    if (
      current === null ||
      current.statusCode !== PENDING_IDEMPOTENCY_STATUS_CODE ||
      current.leaseOwner !== input.leaseOwner ||
      current.leaseExpiresAt === null ||
      current.leaseExpiresAt.getTime() <= input.now.getTime()
    ) {
      throw new LeaseLostError();
    }

    const result = this.database
      .update(idempotencyRecords)
      .set({
        responseJson: JSON.stringify(response),
        statusCode: input.statusCode,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(idempotencyRecords.requestId, input.requestId),
          eq(idempotencyRecords.statusCode, PENDING_IDEMPOTENCY_STATUS_CODE),
          eq(idempotencyRecords.leaseOwner, input.leaseOwner),
          gt(idempotencyRecords.leaseExpiresAt, input.now),
        ),
      )
      .run();

    if (result.changes === 0) {
      throw new LeaseLostError();
    }

    this.releaseSessionMutationLease({
      sessionId: current.sessionId,
      leaseOwner: input.leaseOwner,
      now: input.now,
    });

    const completed = this.findIdempotencyRecordByRequestId(input.requestId);
    if (completed === null) {
      throw new Error("IDEMPOTENCY_RECORD_COMPLETE_FAILED");
    }
    return completed;
  }

  deleteIdempotencyRecord(input: DeleteIdempotencyRecordInput): void {
    const current = this.findIdempotencyRecordByRequestId(input.requestId);
    if (current === null) {
      return;
    }
    if (
      current.statusCode !== PENDING_IDEMPOTENCY_STATUS_CODE ||
      current.leaseOwner !== input.leaseOwner ||
      current.leaseExpiresAt === null ||
      current.leaseExpiresAt.getTime() <= input.now.getTime()
    ) {
      throw new LeaseLostError();
    }

    const result = this.database
      .delete(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.requestId, input.requestId),
          eq(idempotencyRecords.leaseOwner, input.leaseOwner),
          gt(idempotencyRecords.leaseExpiresAt, input.now),
        ),
      )
      .run();

    if (result.changes === 0) {
      throw new LeaseLostError();
    }

    this.releaseSessionMutationLease({
      sessionId: current.sessionId,
      leaseOwner: input.leaseOwner,
      now: input.now,
    });
  }

  findIdempotencyRecordByRequestId(requestId: string): IdempotencyRecord | null {
    const row = this.database
      .select()
      .from(idempotencyRecords)
      .where(eq(idempotencyRecords.requestId, requestId))
      .orderBy(desc(idempotencyRecords.createdAt))
      .limit(1)
      .get();
    return row === undefined ? null : toIdempotencyRecord(row);
  }

  findIdempotencyRecord(sessionId: string, requestId: string): IdempotencyRecord | null {
    const row = this.database
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.sessionId, sessionId),
          eq(idempotencyRecords.requestId, requestId),
        ),
      )
      .get();
    return row === undefined ? null : toIdempotencyRecord(row);
  }

  private acquireSessionLeaseForIdempotency(input: AcquireIdempotencyLeaseInput): void {
    const acquisition = this.acquireSessionMutationLease({
      sessionId: input.sessionId,
      requestId: input.requestId,
      expectedVersion: input.expectedVersion,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: input.leaseExpiresAt,
      now: input.now,
    });

    if (acquisition.status === "version-conflict") {
      throw new SessionVersionConflictError();
    }
    if (acquisition.status === "busy") {
      throw new SessionMutationInProgressError();
    }
  }
}

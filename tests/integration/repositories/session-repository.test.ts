import { describe, expect, it } from "vitest";

import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { createTestDatabase, type TestDatabase } from "@/tests/helpers/test-database";
import { DrizzleSessionRepository } from "@/src/infrastructure/repositories/drizzle-session-repository";
import { sessionMutationLeases } from "@/src/infrastructure/db/schema";
import type { Clock } from "@/src/application/clock";

class ManualClock implements Clock {
  constructor(private currentTime = 0) {}

  now(): Date {
    return new Date(this.currentTime);
  }

  advance(milliseconds: number): void {
    this.currentTime += milliseconds;
  }
}

describe("DrizzleSessionRepository", () => {
  let database: TestDatabase;

  function setup() {
    database = createTestDatabase();
    return new DrizzleSessionRepository(database.db);
  }

  it("round-trips validated preferences and increments the optimistic version", () => {
    const repository = setup();
    const fixtures = makeDomainFixtures();

    try {
      repository.create({ id: fixtures.ids.sessionId });

      repository.acquireSessionMutationLease({
        sessionId: fixtures.ids.sessionId,
        requestId: fixtures.ids.requestId,
        expectedVersion: 0,
        leaseOwner: fixtures.ids.requestId,
        leaseExpiresAt: new Date(Date.now() + 15_000),
        now: new Date(),
      });

      const updated = repository.updateVersion({
        id: fixtures.ids.sessionId,
        expectedVersion: 0,
        leaseOwner: fixtures.ids.requestId,
        state: "SCAN",
        preferences: fixtures.tasteProfile,
      });

      expect(updated.state).toBe("SCAN");
      expect(updated.version).toBe(1);
      expect(updated.preferences).toEqual(fixtures.tasteProfile);
      expect(repository.findById(fixtures.ids.sessionId)?.preferences).toEqual(
        fixtures.tasteProfile,
      );
    } finally {
      database.cleanup();
    }
  });

  it("rejects a stale expected version without changing the session", () => {
    const repository = setup();
    const fixtures = makeDomainFixtures();

    try {
      repository.create({ id: fixtures.ids.sessionId });

      expect(
        repository.acquireSessionMutationLease({
          sessionId: fixtures.ids.sessionId,
          requestId: fixtures.ids.requestId,
          expectedVersion: 1,
          leaseOwner: fixtures.ids.requestId,
          leaseExpiresAt: new Date(Date.now() + 15_000),
          now: new Date(),
        }),
      ).toMatchObject({ status: "version-conflict" });

      expect(repository.findById(fixtures.ids.sessionId)).toMatchObject({
        state: "PREFERENCES",
        version: 0,
      });
    } finally {
      database.cleanup();
    }
  });

  it("stores idempotency responses under a globally unique request ID", () => {
    const repository = setup();
    const fixtures = makeDomainFixtures();

    try {
      repository.create({ id: fixtures.ids.sessionId });
      const response = {
        data: { created: true },
        session: { id: fixtures.ids.sessionId, state: "PREFERENCES", version: 0 },
      };

      repository.saveIdempotencyRecord({
        id: crypto.randomUUID(),
        sessionId: fixtures.ids.sessionId,
        requestId: fixtures.ids.requestId,
        requestFingerprint: "fingerprint-v1",
        statusCode: 201,
        response,
      });

      expect(
        repository.findIdempotencyRecord(fixtures.ids.sessionId, fixtures.ids.requestId),
      ).toMatchObject({
        statusCode: 201,
        response,
      });
      const secondSessionId = crypto.randomUUID();
      repository.create({ id: secondSessionId });
      expect(() =>
        repository.saveIdempotencyRecord({
          id: crypto.randomUUID(),
          sessionId: secondSessionId,
          requestId: fixtures.ids.requestId,
          requestFingerprint: "fingerprint-v2",
          statusCode: 201,
          response: {
            data: { created: true },
            session: { id: secondSessionId, state: "PREFERENCES", version: 0 },
          },
        }),
      ).toThrow();
    } finally {
      database.cleanup();
    }
  });

  it("does not let an expired owner release a replacement owner's session lease", () => {
    const repository = setup();
    const fixtures = makeDomainFixtures();
    const clock = new ManualClock();
    const ownerARequestId = crypto.randomUUID();
    const ownerBRequestId = crypto.randomUUID();
    const ownerA = "owner-a";
    const ownerB = "owner-b";

    try {
      repository.create({ id: fixtures.ids.sessionId });

      expect(
        repository.acquireSessionMutationLease({
          sessionId: fixtures.ids.sessionId,
          requestId: ownerARequestId,
          expectedVersion: 0,
          leaseOwner: ownerA,
          leaseExpiresAt: new Date(1_000),
          now: clock.now(),
        }),
      ).toMatchObject({ status: "acquired" });

      clock.advance(1_001);

      expect(
        repository.acquireSessionMutationLease({
          sessionId: fixtures.ids.sessionId,
          requestId: ownerBRequestId,
          expectedVersion: 0,
          leaseOwner: ownerB,
          leaseExpiresAt: new Date(2_000),
          now: clock.now(),
        }),
      ).toMatchObject({ status: "acquired" });

      const leaseBeforeOldOwnerRelease = database.db.select().from(sessionMutationLeases).get();

      expect(() =>
        repository.releaseSessionMutationLease({
          sessionId: fixtures.ids.sessionId,
          leaseOwner: ownerA,
          now: clock.now(),
        }),
      ).toThrowError("SESSION_MUTATION_LEASE_LOST");

      const leaseAfterOldOwnerRelease = database.db.select().from(sessionMutationLeases).get();

      expect(leaseBeforeOldOwnerRelease).toMatchObject({
        requestId: ownerBRequestId,
        expectedVersion: 0,
        leaseOwner: ownerB,
        leaseExpiresAt: new Date(2_000),
      });
      expect(leaseAfterOldOwnerRelease).toEqual(leaseBeforeOldOwnerRelease);
    } finally {
      database.cleanup();
    }
  });

  it("renews the current owner's session and idempotency leases together", () => {
    const repository = setup();
    const fixtures = makeDomainFixtures();
    const clock = new ManualClock();
    const leaseOwner = "owner-a";
    const requestId = crypto.randomUUID();

    try {
      repository.create({ id: fixtures.ids.sessionId });
      expect(
        repository.acquireIdempotencyLease({
          id: crypto.randomUUID(),
          sessionId: fixtures.ids.sessionId,
          requestId,
          requestFingerprint: "fingerprint-v1",
          expectedVersion: 0,
          response: { pending: true },
          statusCode: 102,
          leaseOwner,
          leaseExpiresAt: new Date(1_000),
          now: clock.now(),
        }),
      ).toMatchObject({ status: "acquired" });

      repository.renewIdempotencyLease({
        requestId,
        expectedVersion: 0,
        leaseOwner,
        leaseExpiresAt: new Date(4_000),
        now: new Date(500),
      });

      expect(() =>
        repository.assertIdempotencyLease({
          requestId,
          expectedVersion: 0,
          leaseOwner,
          now: new Date(3_500),
        }),
      ).not.toThrow();
      expect(() =>
        repository.assertSessionMutationLease({
          sessionId: fixtures.ids.sessionId,
          expectedVersion: 0,
          leaseOwner,
          now: new Date(3_500),
        }),
      ).not.toThrow();
    } finally {
      database.cleanup();
    }
  });

  it("does not shorten the current owner's later lease expiry during renewal", () => {
    const repository = setup();
    const fixtures = makeDomainFixtures();
    const requestId = crypto.randomUUID();

    try {
      repository.create({ id: fixtures.ids.sessionId });
      expect(
        repository.acquireIdempotencyLease({
          id: crypto.randomUUID(),
          sessionId: fixtures.ids.sessionId,
          requestId,
          requestFingerprint: "fingerprint-v1",
          expectedVersion: 0,
          response: { pending: true },
          statusCode: 102,
          leaseOwner: "owner-a",
          leaseExpiresAt: new Date(15_000),
          now: new Date(0),
        }),
      ).toMatchObject({ status: "acquired" });

      repository.renewIdempotencyLease({
        requestId,
        expectedVersion: 0,
        leaseOwner: "owner-a",
        leaseExpiresAt: new Date(11_000),
        now: new Date(500),
      });

      expect(() =>
        repository.assertIdempotencyLease({
          requestId,
          expectedVersion: 0,
          leaseOwner: "owner-a",
          now: new Date(14_000),
        }),
      ).not.toThrow();
      expect(() =>
        repository.assertSessionMutationLease({
          sessionId: fixtures.ids.sessionId,
          expectedVersion: 0,
          leaseOwner: "owner-a",
          now: new Date(14_000),
        }),
      ).not.toThrow();
    } finally {
      database.cleanup();
    }
  });

  it("does not let an old owner renew a replacement owner's idempotency lease", () => {
    const repository = setup();
    const fixtures = makeDomainFixtures();
    const clock = new ManualClock();
    const requestId = crypto.randomUUID();

    try {
      repository.create({ id: fixtures.ids.sessionId });

      expect(
        repository.acquireIdempotencyLease({
          id: crypto.randomUUID(),
          sessionId: fixtures.ids.sessionId,
          requestId,
          requestFingerprint: "fingerprint-v1",
          expectedVersion: 0,
          response: { pending: true },
          statusCode: 102,
          leaseOwner: "owner-a",
          leaseExpiresAt: new Date(1_000),
          now: clock.now(),
        }),
      ).toMatchObject({ status: "acquired" });

      clock.advance(1_001);

      expect(
        repository.acquireIdempotencyLease({
          id: crypto.randomUUID(),
          sessionId: fixtures.ids.sessionId,
          requestId,
          requestFingerprint: "fingerprint-v1",
          expectedVersion: 0,
          response: { pending: true },
          statusCode: 102,
          leaseOwner: "owner-b",
          leaseExpiresAt: new Date(3_000),
          now: clock.now(),
        }),
      ).toMatchObject({ status: "acquired" });

      expect(() =>
        repository.renewIdempotencyLease({
          requestId,
          expectedVersion: 0,
          leaseOwner: "owner-a",
          leaseExpiresAt: new Date(4_000),
          now: clock.now(),
        }),
      ).toThrowError("IDEMPOTENCY_LEASE_LOST");
    } finally {
      database.cleanup();
    }
  });
});

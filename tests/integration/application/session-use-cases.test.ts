import { describe, expect, it, vi } from "vitest";

import { createSession } from "@/src/application/create-session";
import { getSession } from "@/src/application/get-session";
import { fingerprintRequest } from "@/src/application/idempotency";
import { savePreferences } from "@/src/application/save-preferences";
import { createSessionUnitOfWork, type SessionUnitOfWork } from "@/src/application/unit-of-work";
import { createDatabase } from "@/src/infrastructure/db/client";
import type { IdempotencyRecord } from "@/src/repositories/session-repository";
import { SessionEvent } from "@/src/workflow/session-machine";
import { idempotencyRecords, sessions } from "@/src/infrastructure/db/schema";
import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { createTestDatabase } from "@/tests/helpers/test-database";

describe("session application use cases", () => {
  it("creates a session in PREFERENCES at version zero", () => {
    const database = createTestDatabase();
    const fixtures = makeDomainFixtures();
    const unitOfWork = createSessionUnitOfWork(database.db);

    try {
      const result = createSession(unitOfWork, { requestId: fixtures.ids.requestId });

      expect(result.replayed).toBe(false);
      expect(result.response.session).toMatchObject({ state: "PREFERENCES", version: 0 });
      expect(result.response.session.id).toMatch(/^[0-9a-f-]{36}$/i);
    } finally {
      database.cleanup();
    }
  });

  it("replays the first create response for the same request ID without creating another session", () => {
    const database = createTestDatabase();
    const fixtures = makeDomainFixtures();
    const unitOfWork = createSessionUnitOfWork(database.db);

    try {
      const first = createSession(unitOfWork, {
        requestId: fixtures.ids.requestId,
        requestContent: { source: "mobile" },
      });
      const second = createSession(unitOfWork, {
        requestId: fixtures.ids.requestId,
        requestContent: { source: "mobile" },
      });

      expect(second.replayed).toBe(true);
      expect(second.response).toEqual(first.response);
      expect(database.db.select().from(sessions).all()).toHaveLength(1);
    } finally {
      database.cleanup();
    }
  });

  it("rejects a reused request ID when the create request content differs", () => {
    const database = createTestDatabase();
    const fixtures = makeDomainFixtures();
    const unitOfWork = createSessionUnitOfWork(database.db);

    try {
      createSession(unitOfWork, {
        requestId: fixtures.ids.requestId,
        requestContent: { source: "mobile" },
      });

      expect(() =>
        createSession(unitOfWork, {
          requestId: fixtures.ids.requestId,
          requestContent: { source: "desktop" },
        }),
      ).toThrowError("IDEMPOTENCY_KEY_REUSED");
      expect(database.db.select().from(sessions).all()).toHaveLength(1);
    } finally {
      database.cleanup();
    }
  });

  it("saves preferences through the state machine and one transaction", () => {
    const database = createTestDatabase();
    const fixtures = makeDomainFixtures();
    const unitOfWork = createSessionUnitOfWork(database.db);

    try {
      const created = createSession(unitOfWork, { requestId: fixtures.ids.requestId });
      const result = savePreferences(unitOfWork, {
        sessionId: created.response.session.id,
        requestId: crypto.randomUUID(),
        expectedVersion: 0,
        preferences: fixtures.tasteProfile,
      });

      expect(result.response.session).toMatchObject({ state: "SCAN", version: 1 });
      expect(result.response.data.preferences).toEqual(fixtures.tasteProfile);
      expect(result.transitionEvent).toBe(SessionEvent.SAVE_PREFERENCES);
      expect(database.db.select().from(idempotencyRecords).all()).toHaveLength(2);
    } finally {
      database.cleanup();
    }
  });

  it("does not write on a stale version and reports VERSION_CONFLICT", () => {
    const database = createTestDatabase();
    const fixtures = makeDomainFixtures();
    const unitOfWork = createSessionUnitOfWork(database.db);

    try {
      const created = createSession(unitOfWork, { requestId: fixtures.ids.requestId });

      expect(() =>
        savePreferences(unitOfWork, {
          sessionId: created.response.session.id,
          requestId: crypto.randomUUID(),
          expectedVersion: 1,
          preferences: fixtures.tasteProfile,
        }),
      ).toThrowError("VERSION_CONFLICT");

      expect(getSession(unitOfWork, { sessionId: created.response.session.id })).toMatchObject({
        state: "PREFERENCES",
        version: 0,
        preferences: null,
      });
      expect(database.db.select().from(idempotencyRecords).all()).toHaveLength(1);
    } finally {
      database.cleanup();
    }
  });

  it("replays a preference save for the same request content and rejects a changed payload", () => {
    const database = createTestDatabase();
    const fixtures = makeDomainFixtures();
    const unitOfWork = createSessionUnitOfWork(database.db);

    try {
      const created = createSession(unitOfWork, { requestId: fixtures.ids.requestId });
      const requestId = crypto.randomUUID();
      const first = savePreferences(unitOfWork, {
        sessionId: created.response.session.id,
        requestId,
        expectedVersion: 0,
        preferences: fixtures.tasteProfile,
      });
      const replay = savePreferences(unitOfWork, {
        sessionId: created.response.session.id,
        requestId,
        expectedVersion: 0,
        preferences: fixtures.tasteProfile,
      });

      expect(replay.replayed).toBe(true);
      expect(replay.response).toEqual(first.response);

      expect(() =>
        savePreferences(unitOfWork, {
          sessionId: created.response.session.id,
          requestId,
          expectedVersion: 0,
          preferences: { ...fixtures.tasteProfile, body: 5 },
        }),
      ).toThrowError("IDEMPOTENCY_KEY_REUSED");
    } finally {
      database.cleanup();
    }
  });

  it("returns the persisted session snapshot for recovery", () => {
    const database = createTestDatabase();
    const fixtures = makeDomainFixtures();
    const unitOfWork = createSessionUnitOfWork(database.db);

    try {
      const created = createSession(unitOfWork, { requestId: fixtures.ids.requestId });
      savePreferences(unitOfWork, {
        sessionId: created.response.session.id,
        requestId: crypto.randomUUID(),
        expectedVersion: 0,
        preferences: fixtures.tasteProfile,
      });

      expect(getSession(unitOfWork, { sessionId: created.response.session.id })).toMatchObject({
        id: created.response.session.id,
        state: "SCAN",
        version: 1,
        preferences: fixtures.tasteProfile,
      });
    } finally {
      database.cleanup();
    }
  });

  it("replays one create result across two database handles for the same request ID", async () => {
    const database = createTestDatabase();
    const secondDatabase = createDatabase(database.databasePath);
    const fixtures = makeDomainFixtures();
    const firstUnitOfWork = createSessionUnitOfWork(database.db);
    const secondUnitOfWork = createSessionUnitOfWork(secondDatabase.db);

    try {
      const [first, second] = await Promise.all([
        Promise.resolve().then(() =>
          createSession(firstUnitOfWork, {
            requestId: fixtures.ids.requestId,
            requestContent: { source: "mobile" },
          }),
        ),
        Promise.resolve().then(() =>
          createSession(secondUnitOfWork, {
            requestId: fixtures.ids.requestId,
            requestContent: { source: "mobile" },
          }),
        ),
      ]);

      expect(first.response).toEqual(second.response);
      expect([first.replayed, second.replayed].filter(Boolean)).toHaveLength(1);
      expect(
        firstUnitOfWork.read().findIdempotencyRecordByRequestId(fixtures.ids.requestId),
      ).not.toBe(null);
    } finally {
      secondDatabase.close();
      database.cleanup();
    }
  });

  it("does not replay an idempotency record across operations", () => {
    const database = createTestDatabase();
    const fixtures = makeDomainFixtures();
    const unitOfWork = createSessionUnitOfWork(database.db);

    try {
      const requestId = crypto.randomUUID();
      const fakeSessionId = crypto.randomUUID();
      createSession(unitOfWork, {
        requestId,
        requestContent: {
          sessionId: fakeSessionId,
          expectedVersion: 0,
          preferences: fixtures.tasteProfile,
        },
      });

      expect(() =>
        savePreferences(unitOfWork, {
          sessionId: fakeSessionId,
          requestId,
          expectedVersion: 0,
          preferences: fixtures.tasteProfile,
        }),
      ).toThrowError("IDEMPOTENCY_KEY_REUSED");
    } finally {
      database.cleanup();
    }
  });

  it("replays the winner after a unique request ID race", () => {
    const database = createTestDatabase();
    const requestId = crypto.randomUUID();
    const requestContent = { source: "mobile" };
    const winnerSessionId = crypto.randomUUID();
    const winnerResponse = {
      data: { created: true },
      session: { id: winnerSessionId, state: "PREFERENCES", version: 0 },
    };
    const winnerRecord: IdempotencyRecord = {
      id: crypto.randomUUID(),
      sessionId: winnerSessionId,
      requestId,
      requestFingerprint: fingerprintRequest({
        operation: "create-session",
        requestContent,
      }),
      response: winnerResponse,
      statusCode: 201,
      leaseOwner: null,
      leaseExpiresAt: null,
      createdAt: new Date(),
    };
    const realUnitOfWork = createSessionUnitOfWork(database.db);
    const readRepository = realUnitOfWork.read();
    let raceWon = false;

    vi.spyOn(readRepository, "findIdempotencyRecordByRequestId").mockImplementation(
      (candidateRequestId) => (candidateRequestId === requestId && raceWon ? winnerRecord : null),
    );

    const racingUnitOfWork: SessionUnitOfWork = {
      read: () => readRepository,
      transaction: (operation) =>
        realUnitOfWork.transaction((repository) => {
          vi.spyOn(repository, "saveIdempotencyRecord").mockImplementation(() => {
            raceWon = true;
            throw new Error("UNIQUE constraint failed: idempotency_records.request_id");
          });
          return operation(repository);
        }),
    };

    try {
      const result = createSession(racingUnitOfWork, {
        requestId,
        requestContent,
      });

      expect(result.replayed).toBe(true);
      expect(raceWon).toBe(true);
      expect(result.response).toEqual(winnerResponse);
      expect(database.db.select().from(sessions).all()).toHaveLength(0);
    } finally {
      database.cleanup();
    }
  });
});

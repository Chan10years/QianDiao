import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { ingredients, sessions } from "@/src/infrastructure/db/schema";
import { createSession } from "@/src/application/create-session";
import { savePreferences } from "@/src/application/save-preferences";
import { createSessionRouteHandlers } from "@/app/api/sessions/route";
import { createSessionDetailRouteHandlers } from "@/app/api/sessions/[sessionId]/route";
import { createPreferenceRouteHandlers } from "@/app/api/sessions/[sessionId]/preferences/route";
import { createSessionUnitOfWork } from "@/src/application/unit-of-work";
import { SessionErrorEnvelopeSchema, mapSessionError } from "@/src/infrastructure/http/envelopes";
import { ErrorEnvelopeSchema } from "@/src/domain/api";
import {
  AdjustmentInvalidStateError,
  AdjustmentSafetyBlockedError,
} from "@/src/application/generate-adjustment";
import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { createTestDatabase } from "@/tests/helpers/test-database";

const jsonRequest = (body: unknown, method: "POST" | "PUT" = "POST") =>
  new Request("http://localhost/api/sessions", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("session route handlers", () => {
  it("creates and resumes a session through thin handlers", async () => {
    const database = createTestDatabase();
    const fixtures = makeDomainFixtures();
    const unitOfWork = createSessionUnitOfWork(database.db);

    try {
      const createHandlers = createSessionRouteHandlers(unitOfWork);
      const createdResponse = await createHandlers.POST(
        jsonRequest({ requestId: fixtures.ids.requestId }),
      );
      const createdBody = await createdResponse.json();

      expect(createdResponse.status).toBe(201);
      expect(createdBody.session).toMatchObject({ state: "PREFERENCES", version: 0 });

      const preferenceHandlers = createPreferenceRouteHandlers(unitOfWork);
      const preferenceRequestId = crypto.randomUUID();
      const preferenceBody = {
        requestId: preferenceRequestId,
        expectedVersion: 0,
        preferences: fixtures.tasteProfile,
      };
      const savedResponse = await preferenceHandlers.PUT(jsonRequest(preferenceBody, "PUT"), {
        params: Promise.resolve({ sessionId: createdBody.session.id }),
      });
      const replayedResponse = await preferenceHandlers.PUT(jsonRequest(preferenceBody, "PUT"), {
        params: Promise.resolve({ sessionId: createdBody.session.id }),
      });

      expect(savedResponse.status).toBe(200);
      expect(await savedResponse.clone().json()).toMatchObject({
        session: { state: "SCAN", version: 1 },
      });
      expect(replayedResponse.status).toBe(200);
      expect(await replayedResponse.json()).toEqual(await savedResponse.json());

      const detailHandlers = createSessionDetailRouteHandlers(unitOfWork);
      const resumedResponse = await detailHandlers.GET(new Request("http://localhost"), {
        params: Promise.resolve({ sessionId: createdBody.session.id }),
      });

      expect(resumedResponse.status).toBe(200);
      expect(await resumedResponse.json()).toMatchObject({
        session: { id: createdBody.session.id, state: "SCAN", version: 1 },
        data: { preferences: fixtures.tasteProfile },
      });
    } finally {
      database.cleanup();
    }
  });

  it("maps malformed JSON, missing sessions, and conflicts to stable HTTP errors", async () => {
    const database = createTestDatabase();
    const fixtures = makeDomainFixtures();
    const unitOfWork = createSessionUnitOfWork(database.db);

    try {
      const createHandlers = createSessionRouteHandlers(unitOfWork);
      const malformed = await createHandlers.POST(
        new Request("http://localhost/api/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
      );
      expect(malformed.status).toBe(400);

      const preferenceHandlers = createPreferenceRouteHandlers(unitOfWork);
      const missing = await preferenceHandlers.PUT(
        jsonRequest(
          {
            requestId: fixtures.ids.requestId,
            expectedVersion: 0,
            preferences: fixtures.tasteProfile,
          },
          "PUT",
        ),
        { params: Promise.resolve({ sessionId: crypto.randomUUID() }) },
      );
      expect(missing.status).toBe(404);

      const created = createSession(unitOfWork, { requestId: fixtures.ids.requestId });
      const stale = await preferenceHandlers.PUT(
        jsonRequest(
          {
            requestId: crypto.randomUUID(),
            expectedVersion: 1,
            preferences: fixtures.tasteProfile,
          },
          "PUT",
        ),
        { params: Promise.resolve({ sessionId: created.response.session.id }) },
      );

      expect(stale.status).toBe(409);
      expect((await stale.json()).error.code).toBe("VERSION_CONFLICT");
    } finally {
      database.cleanup();
    }
  });

  it("returns IDEMPOTENCY_KEY_REUSED for a changed request body", async () => {
    const database = createTestDatabase();
    const fixtures = makeDomainFixtures();
    const unitOfWork = createSessionUnitOfWork(database.db);

    try {
      const createHandlers = createSessionRouteHandlers(unitOfWork);
      const first = await createHandlers.POST(
        jsonRequest({ requestId: fixtures.ids.requestId, source: "mobile" }),
      );
      expect(first.status).toBe(201);

      const second = await createHandlers.POST(
        jsonRequest({ requestId: fixtures.ids.requestId, source: "desktop" }),
      );
      expect(second.status).toBe(409);
      expect((await second.json()).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    } finally {
      database.cleanup();
    }
  });

  it("returns persisted ingredients in the CONFIRM session snapshot", async () => {
    const database = createTestDatabase();
    const fixtures = makeDomainFixtures();
    const unitOfWork = createSessionUnitOfWork(database.db);

    try {
      const created = createSession(unitOfWork, { requestId: fixtures.ids.requestId });
      savePreferencesForSnapshot(unitOfWork, created.response.session.id, fixtures);
      const persistedIngredient = {
        rawName: "二锅头",
        canonicalName: "白酒",
        category: "spirit" as const,
        brand: null,
        abv: 42,
        confidence: 0.72,
        confirmed: false,
      };
      database.db
        .update(sessions)
        .set({ state: "CONFIRM", version: 2 })
        .where(eq(sessions.id, created.response.session.id))
        .run();
      database.db
        .insert(ingredients)
        .values({
          id: crypto.randomUUID(),
          sessionId: created.response.session.id,
          ...persistedIngredient,
        })
        .run();

      const response = await createSessionDetailRouteHandlers(unitOfWork).GET(
        new Request("http://localhost"),
        { params: Promise.resolve({ sessionId: created.response.session.id }) },
      );

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        session: { state: "CONFIRM", version: 2 },
        data: { ingredients: [persistedIngredient] },
      });
      expect(body.data.ingredients[0]).not.toHaveProperty("id");
      expect(body.data.ingredients[0]).not.toHaveProperty("sessionId");
      expect(body.data.ingredients[0]).not.toHaveProperty("createdAt");
    } finally {
      database.cleanup();
    }
  });

  it("does not expose stack, secret, or absolute path details in a 500 error", async () => {
    const response = mapSessionError(
      new Error("DASHSCOPE_API_KEY=secret-value at C:\\workspace\\app.db"),
    );
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(500);
    expect(serialized).not.toContain("DASHSCOPE_API_KEY");
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("C:\\workspace\\app.db");
    expect(serialized).not.toContain("stack");
  });

  it("maps adjustment Safety BLOCK to SAFETY_BLOCKED without changing INVALID_STATE", async () => {
    const response = mapSessionError(new AdjustmentSafetyBlockedError());
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("SAFETY_BLOCKED");
    expect(SessionErrorEnvelopeSchema.parse(body).error.code).toBe("SAFETY_BLOCKED");
    expect(ErrorEnvelopeSchema.parse(body).error.code).toBe("SAFETY_BLOCKED");

    const invalidStateResponse = mapSessionError(new AdjustmentInvalidStateError());
    expect(invalidStateResponse.status).toBe(409);
    expect((await invalidStateResponse.json()).error.code).toBe("INVALID_STATE");
  });
});

function savePreferencesForSnapshot(
  unitOfWork: ReturnType<typeof createSessionUnitOfWork>,
  sessionId: string,
  fixtures: ReturnType<typeof makeDomainFixtures>,
): void {
  savePreferences(unitOfWork, {
    sessionId,
    requestId: crypto.randomUUID(),
    expectedVersion: 0,
    preferences: fixtures.tasteProfile,
  });
}

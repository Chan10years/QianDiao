import { describe, expect, it, vi } from "vitest";

import { createMixingAdvanceRouteHandlers } from "@/app/api/sessions/[sessionId]/mixing/advance/route";
import type { AdvanceMixingDependencies } from "@/src/application/advance-mixing";
import { RecipeCandidateSchema } from "@/src/domain/recipe";
import type { RecipeRecord } from "@/src/repositories/recipe-repository";
import type { SessionRecord } from "@/src/repositories/session-repository";
import { makeDomainFixtures } from "@/tests/fixtures/domain";

describe("mixing advance route", () => {
  it("maps the action to the application use case and returns the authoritative session", async () => {
    const fixtures = makeDomainFixtures();
    const sessionId = fixtures.ids.sessionId;
    const recipeCandidate = RecipeCandidateSchema.parse({
      ...fixtures.recipes[0],
      steps: [...fixtures.recipes[0].steps, { order: 2, instruction: "最后轻轻搅拌并观察香气。" }],
    });
    const session: SessionRecord = {
      id: sessionId,
      state: "MIXING",
      version: 2,
      preferences: fixtures.tasteProfile,
      selectedRecipeId: recipeCandidate.id,
      currentStep: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const recipe: RecipeRecord = {
      ...recipeCandidate,
      sessionId,
      recipeSetId: crypto.randomUUID(),
      version: 1,
      parentRecipeId: null,
      feedbackId: null,
      createdAt: new Date(),
    };
    const updatedSession = { ...session, version: 3, currentStep: 1 };
    const updateVersion = vi.fn(() => updatedSession);
    const saveIdempotencyRecord = vi.fn();
    const releaseSessionMutationLease = vi.fn();
    const repository = {
      findById: vi.fn(() => session),
      findIdempotencyRecordByRequestId: vi.fn(() => null),
      findRecipeById: vi.fn(() => recipe),
      updateVersion,
      saveIdempotencyRecord,
      acquireSessionMutationLease: vi.fn(() => ({ status: "acquired" as const, session })),
      assertSessionMutationLease: vi.fn(),
      renewSessionMutationLease: vi.fn(),
      releaseSessionMutationLease,
    };
    const dependencies: AdvanceMixingDependencies = {
      read: () => repository,
      transaction: (operation) => operation(repository),
    };

    const response = await createMixingAdvanceRouteHandlers(dependencies).POST(
      new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          expectedVersion: 2,
          action: "ADVANCE_MIXING",
        }),
      }),
      { params: Promise.resolve({ sessionId }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { action: "ADVANCE_MIXING", currentStep: 1, totalSteps: recipe.steps.length },
      session: { id: sessionId, state: "MIXING", version: 3 },
    });
    expect(updateVersion).toHaveBeenCalledWith(
      expect.objectContaining({ id: sessionId, expectedVersion: 2, currentStep: 1 }),
    );
    expect(saveIdempotencyRecord).toHaveBeenCalledOnce();
    expect(releaseSessionMutationLease).toHaveBeenCalledOnce();

    const boundaryResponse = await createMixingAdvanceRouteHandlers(dependencies).POST(
      new Request("http://localhost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          expectedVersion: 2,
          action: "BACK_MIXING",
        }),
      }),
      { params: Promise.resolve({ sessionId }) },
    );

    expect(boundaryResponse.status).toBe(409);
    expect(await boundaryResponse.json()).toMatchObject({
      error: { code: "INVALID_STATE", message: "当前会话状态不允许此操作" },
    });
  });
});

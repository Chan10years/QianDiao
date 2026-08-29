import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { createTestDatabase, type TestDatabase } from "@/tests/helpers/test-database";
import { DrizzleRecipeRepository } from "@/src/infrastructure/repositories/drizzle-recipe-repository";
import { DrizzleSessionRepository } from "@/src/infrastructure/repositories/drizzle-session-repository";
import { withTransaction } from "@/src/infrastructure/db/transaction";

describe("DrizzleRecipeRepository", () => {
  let database: TestDatabase;

  function setup() {
    database = createTestDatabase();
    return makeDomainFixtures();
  }

  it("writes a recipe set, three recipes, safety decisions, an event, and the session version together", () => {
    const fixtures = setup();

    try {
      new DrizzleSessionRepository(database.db).create({ id: fixtures.ids.sessionId });

      withTransaction(database.db, (transaction) => {
        new DrizzleRecipeRepository(transaction).createBatch({
          sessionId: fixtures.ids.sessionId,
          requestId: randomUUID(),
          expectedVersion: 0,
          recipeSetId: randomUUID(),
          sourceMode: "fallback",
          recipes: fixtures.recipes.map((candidate) => ({ candidate })),
          recommendedRecipeId: fixtures.recipeSet.recommendedRecipeId,
          safetyDecisions: fixtures.recipes.map((candidate) => ({
            recipeId: candidate.id,
            level: "ALLOW",
            ruleHits: [],
            engineVersion: "1.0.0",
          })),
          event: {
            type: "recipe_set_generated",
            summary: "已生成三套本地保底配方。",
            metadata: { sourceMode: "fallback" },
          },
        });
      });

      const repository = new DrizzleRecipeRepository(database.db);
      const recipeSet = repository.findSetBySession(fixtures.ids.sessionId);

      expect(recipeSet).not.toBeNull();
      expect(recipeSet?.recommendedRecipeId).toBe(fixtures.recipeSet.recommendedRecipeId);
      expect(repository.listBySet(recipeSet?.id ?? "")).toHaveLength(3);
      expect(repository.listSafetyDecisionsBySet(recipeSet?.id ?? "")).toHaveLength(3);
      expect(repository.listDecisionEvents(fixtures.ids.sessionId)).toHaveLength(1);
      expect(
        new DrizzleSessionRepository(database.db).findById(fixtures.ids.sessionId),
      ).toMatchObject({
        state: "RECIPE_SELECTION",
        version: 1,
      });
    } finally {
      database.cleanup();
    }
  });

  it("selects the later-inserted active batch when createdAt and UUID ordering disagree", () => {
    const fixtures = setup();
    const oldRecipeSetId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const newRecipeSetId = "00000000-0000-4000-8000-000000000000";

    try {
      new DrizzleSessionRepository(database.db).create({ id: fixtures.ids.sessionId });
      const repository = new DrizzleRecipeRepository(database.db);

      const createBatch = (recipeSetId: string, expectedVersion: number) => {
        const candidates = fixtures.recipes.map((candidate) => ({
          ...candidate,
          id: randomUUID(),
        }));
        withTransaction(database.db, (transaction) => {
          new DrizzleRecipeRepository(transaction).createBatch({
            sessionId: fixtures.ids.sessionId,
            requestId: randomUUID(),
            expectedVersion,
            recipeSetId,
            sourceMode: "fallback",
            recipes: candidates.map((candidate) => ({ candidate })),
            recommendedRecipeId: candidates[0]?.id ?? "",
            safetyDecisions: candidates.map((candidate) => ({
              recipeId: candidate.id,
              level: "ALLOW",
              ruleHits: [],
              engineVersion: "1.0.0",
            })),
            event: {
              type: "recipe_set_generated",
              summary: "测试批次",
              metadata: {
                provenance: {
                  recipeSetId,
                  sourceMode: "fallback",
                  degraded: false,
                  stages: [],
                },
                sourceMode: "fallback",
                degraded: false,
              },
            },
          });
        });
      };

      createBatch(oldRecipeSetId, 0);
      createBatch(newRecipeSetId, 1);
      database.sqlite
        .prepare("UPDATE recipe_sets SET created_at = ? WHERE session_id = ?")
        .run(1234567890000, fixtures.ids.sessionId);

      expect(repository.findSetBySession(fixtures.ids.sessionId)?.id).toBe(newRecipeSetId);
    } finally {
      database.cleanup();
    }
  });

  it("rolls back every write when a transaction fails after intermediate inserts", () => {
    const fixtures = setup();

    try {
      new DrizzleSessionRepository(database.db).create({ id: fixtures.ids.sessionId });

      expect(() =>
        withTransaction(database.db, (transaction) => {
          new DrizzleRecipeRepository(transaction).createBatch({
            sessionId: fixtures.ids.sessionId,
            requestId: randomUUID(),
            expectedVersion: 0,
            recipeSetId: randomUUID(),
            sourceMode: "fallback",
            recipes: fixtures.recipes.map((candidate) => ({ candidate })),
            recommendedRecipeId: fixtures.recipeSet.recommendedRecipeId,
            safetyDecisions: fixtures.recipes.map((candidate) => ({
              recipeId: candidate.id,
              level: "ALLOW",
              ruleHits: [],
              engineVersion: "1.0.0",
            })),
            event: {
              type: "recipe_set_generated",
              summary: "已生成三套本地保底配方。",
              metadata: { sourceMode: "fallback" },
            },
          });
          throw new Error("injected failure");
        }),
      ).toThrowError("injected failure");

      const repository = new DrizzleRecipeRepository(database.db);
      expect(repository.findSetBySession(fixtures.ids.sessionId)).toBeNull();
      expect(repository.listDecisionEvents(fixtures.ids.sessionId)).toHaveLength(0);
      expect(
        new DrizzleSessionRepository(database.db).findById(fixtures.ids.sessionId),
      ).toMatchObject({
        state: "PREFERENCES",
        version: 0,
      });
    } finally {
      database.cleanup();
    }
  });

  it("preserves recipe version and parent links", () => {
    const fixtures = setup();

    try {
      new DrizzleSessionRepository(database.db).create({ id: fixtures.ids.sessionId });
      const repository = new DrizzleRecipeRepository(database.db);
      const recipeSetId = repository.createRecipeSet({
        id: randomUUID(),
        sessionId: fixtures.ids.sessionId,
        sourceMode: "fallback",
      });
      const first = repository.createRecipe({
        recipeSetId,
        sessionId: fixtures.ids.sessionId,
        candidate: fixtures.recipes[0],
        version: 1,
        parentRecipeId: null,
      });
      const secondRecipeSetId = repository.createRecipeSet({
        id: randomUUID(),
        sessionId: fixtures.ids.sessionId,
        sourceMode: "fallback",
      });
      const second = repository.createRecipe({
        recipeSetId: secondRecipeSetId,
        sessionId: fixtures.ids.sessionId,
        candidate: { ...fixtures.recipes[0], id: randomUUID() },
        version: 2,
        parentRecipeId: first.id,
      });

      expect(second.version).toBe(2);
      expect(second.parentRecipeId).toBe(first.id);
      expect(repository.findById(second.id)?.parentRecipeId).toBe(first.id);
    } finally {
      database.cleanup();
    }
  });
  it("defaults an omitted recipe version to one with no parent", () => {
    const fixtures = setup();

    try {
      new DrizzleSessionRepository(database.db).create({ id: fixtures.ids.sessionId });
      const repository = new DrizzleRecipeRepository(database.db);
      const recipeSetId = repository.createRecipeSet({
        id: randomUUID(),
        sessionId: fixtures.ids.sessionId,
        sourceMode: "fallback",
      });

      const recipe = repository.createRecipe({
        recipeSetId,
        sessionId: fixtures.ids.sessionId,
        candidate: fixtures.recipes[0],
      });

      expect(recipe.version).toBe(1);
      expect(recipe.parentRecipeId).toBeNull();
    } finally {
      database.cleanup();
    }
  });
});

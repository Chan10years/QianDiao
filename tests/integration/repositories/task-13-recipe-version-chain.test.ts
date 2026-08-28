import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { createTestDatabase, type TestDatabase } from "@/tests/helpers/test-database";
import { RecipeIdSchema } from "@/src/domain/id";
import { RecipeCandidateSchema } from "@/src/domain/recipe";
import { DrizzleFeedbackRepository } from "@/src/infrastructure/repositories/drizzle-feedback-repository";
import { DrizzleRecipeRepository } from "@/src/infrastructure/repositories/drizzle-recipe-repository";
import { DrizzleSessionRepository } from "@/src/infrastructure/repositories/drizzle-session-repository";
import { getCurrentRecipe } from "@/src/application/get-current-recipe";
import { getRecipeVersionChain } from "@/src/application/get-recipe-version-chain";
import { getRecipeSet } from "@/src/application/get-recipe-set";
import { RecipeDataIntegrityError, type RecipeRecord } from "@/src/repositories/recipe-repository";

interface VersionedFixture {
  database: TestDatabase;
  repository: DrizzleRecipeRepository;
  sessionId: string;
  initialRecipe: RecipeRecord;
  secondRecipe: RecipeRecord;
  thirdRecipe: RecipeRecord;
  firstFeedbackId: string;
  secondFeedbackId: string;
}

function createInitialSet(
  repository: DrizzleRecipeRepository,
  sessionId: string,
  candidates: ReturnType<typeof makeDomainFixtures>["recipes"],
): RecipeRecord[] {
  const recipeSetId = randomUUID();
  repository.createRecipeSet({ id: recipeSetId, sessionId, sourceMode: "fallback" });
  return candidates.map((candidate) =>
    repository.createRecipe({
      recipeSetId,
      sessionId,
      candidate,
      version: 1,
      parentRecipeId: null,
      feedbackId: null,
    }),
  );
}

function createAdjustedCandidate(
  candidate: ReturnType<typeof makeDomainFixtures>["recipes"][number],
  title: string,
) {
  return RecipeCandidateSchema.parse({
    ...candidate,
    id: RecipeIdSchema.parse(randomUUID()),
    title,
  });
}

function createFeedback(database: TestDatabase, sessionId: string, recipeId: string): string {
  const id = randomUUID();
  const feedback = new DrizzleFeedbackRepository(database.db).create({
    id,
    sessionId,
    recipeId,
    feedback: {
      rating: 3,
      accepted: false,
      deltas: {
        sweetness: 0,
        acidity: 0,
        alcoholIntensity: -1,
        body: 0,
      },
      notes: "希望酒感更柔和。",
      finalImageId: null,
    },
  });
  return feedback.id;
}

function createVersionedFixture(): VersionedFixture {
  const database = createTestDatabase();
  const fixtures = makeDomainFixtures();
  const sessionId = fixtures.ids.sessionId;
  new DrizzleSessionRepository(database.db).create({ id: sessionId });
  const repository = new DrizzleRecipeRepository(database.db);
  const initialRecipes = createInitialSet(repository, sessionId, fixtures.recipes);
  const initialRecipe = initialRecipes[0];
  if (initialRecipe === undefined) {
    throw new Error("TEST_FIXTURE_INVALID");
  }

  const firstFeedbackId = createFeedback(database, sessionId, initialRecipe.id);
  const secondRecipeSetId = randomUUID();
  const secondRecipe = repository.createSingleRecipeSet({
    recipeSet: {
      id: secondRecipeSetId,
      sessionId,
      sourceMode: "fallback",
    },
    recipe: {
      recipeSetId: secondRecipeSetId,
      sessionId,
      candidate: createAdjustedCandidate(fixtures.recipes[0], "V2 调饮"),
      version: 2,
      parentRecipeId: initialRecipe.id,
      feedbackId: firstFeedbackId,
    },
  });
  const secondFeedbackId = createFeedback(database, sessionId, secondRecipe.id);
  const thirdRecipeSetId = randomUUID();
  const thirdRecipe = repository.createSingleRecipeSet({
    recipeSet: {
      id: thirdRecipeSetId,
      sessionId,
      sourceMode: "fallback",
    },
    recipe: {
      recipeSetId: thirdRecipeSetId,
      sessionId,
      candidate: createAdjustedCandidate(fixtures.recipes[0], "V3 调饮"),
      version: 3,
      parentRecipeId: secondRecipe.id,
      feedbackId: secondFeedbackId,
    },
  });

  return {
    database,
    repository,
    sessionId,
    initialRecipe,
    secondRecipe,
    thirdRecipe,
    firstFeedbackId,
    secondFeedbackId,
  };
}

describe("Task 13 recipe version chain repository", () => {
  it("keeps the V1 three-card set and writes each adjustment as a one-card set", () => {
    const fixtures = makeDomainFixtures();
    const database = createTestDatabase();

    try {
      new DrizzleSessionRepository(database.db).create({ id: fixtures.ids.sessionId });
      const repository = new DrizzleRecipeRepository(database.db);
      const initialRecipes = createInitialSet(repository, fixtures.ids.sessionId, fixtures.recipes);
      const initialRecipe = initialRecipes[0];
      if (initialRecipe === undefined) {
        throw new Error("TEST_FIXTURE_INVALID");
      }

      const firstFeedbackId = new DrizzleFeedbackRepository(database.db).create({
        id: randomUUID(),
        sessionId: fixtures.ids.sessionId,
        recipeId: initialRecipe.id,
        feedback: fixtures.feedback,
      }).id;
      const secondRecipeSetId = randomUUID();
      const secondRecipe = repository.createSingleRecipeSet({
        recipeSet: {
          id: secondRecipeSetId,
          sessionId: fixtures.ids.sessionId,
          sourceMode: "fallback",
        },
        recipe: {
          recipeSetId: secondRecipeSetId,
          sessionId: fixtures.ids.sessionId,
          candidate: createAdjustedCandidate(fixtures.recipes[0], "V2 调饮"),
          version: 2,
          parentRecipeId: initialRecipe.id,
          feedbackId: firstFeedbackId,
        },
      });
      const secondFeedbackId = new DrizzleFeedbackRepository(database.db).create({
        id: randomUUID(),
        sessionId: fixtures.ids.sessionId,
        recipeId: secondRecipe.id,
        feedback: fixtures.feedback,
      }).id;
      const thirdRecipeSetId = randomUUID();
      const thirdRecipe = repository.createSingleRecipeSet({
        recipeSet: {
          id: thirdRecipeSetId,
          sessionId: fixtures.ids.sessionId,
          sourceMode: "fallback",
        },
        recipe: {
          recipeSetId: thirdRecipeSetId,
          sessionId: fixtures.ids.sessionId,
          candidate: createAdjustedCandidate(fixtures.recipes[0], "V3 调饮"),
          version: 3,
          parentRecipeId: secondRecipe.id,
          feedbackId: secondFeedbackId,
        },
      });

      expect(repository.findInitialRecipeSetBySession(fixtures.ids.sessionId)).toEqual(
        expect.arrayContaining(initialRecipes),
      );
      expect(repository.findInitialRecipeSetBySession(fixtures.ids.sessionId)).toHaveLength(3);
      expect(repository.listBySet(secondRecipe.recipeSetId)).toHaveLength(1);
      expect(repository.listBySet(thirdRecipe.recipeSetId)).toHaveLength(1);
      expect(repository.findById(secondRecipe.id)).toMatchObject({
        version: 2,
        parentRecipeId: initialRecipe.id,
        feedbackId: firstFeedbackId,
      });
      expect(repository.findById(thirdRecipe.id)).toMatchObject({
        version: 3,
        parentRecipeId: secondRecipe.id,
        feedbackId: secondFeedbackId,
      });

      database.sqlite
        .prepare("UPDATE sessions SET selected_recipe_id = ? WHERE id = ?")
        .run(thirdRecipe.id, fixtures.ids.sessionId);
      expect(repository.findCurrentRecipeBySession(fixtures.ids.sessionId)?.id).toBe(
        thirdRecipe.id,
      );
      expect(repository.listRecipeVersionChain(thirdRecipe.id).map((recipe) => recipe.id)).toEqual([
        initialRecipe.id,
        secondRecipe.id,
        thirdRecipe.id,
      ]);
    } finally {
      database.cleanup();
    }
  });

  it("reads the selected current recipe and its persisted safety summary without the three-card path", () => {
    const context = createVersionedFixture();

    try {
      for (const recipe of [context.initialRecipe, context.secondRecipe, context.thirdRecipe]) {
        context.database.sqlite
          .prepare(
            "INSERT INTO safety_decisions (id, recipe_id, level, rule_hits_json, engine_version, created_at) VALUES (?, ?, 'ALLOW', '[]', '1.0.0', 0)",
          )
          .run(randomUUID(), recipe.id);
      }
      context.database.sqlite
        .prepare("UPDATE sessions SET selected_recipe_id = ? WHERE id = ?")
        .run(context.thirdRecipe.id, context.sessionId);

      const read = {
        read: () => ({
          findById: (id: string) => new DrizzleSessionRepository(context.database.db).findById(id),
          findCurrentRecipeBySession: (sessionId: string) =>
            context.repository.findCurrentRecipeBySession(sessionId),
          listSafetyDecisionsBySet: (recipeSetId: string) =>
            context.repository.listSafetyDecisionsBySet(recipeSetId),
          listRecipeVersionChain: (recipeId: string) =>
            context.repository.listRecipeVersionChain(recipeId),
        }),
      };

      expect(getCurrentRecipe(read, { sessionId: context.sessionId })).toMatchObject({
        recipeId: context.thirdRecipe.id,
        recipeSetId: context.thirdRecipe.recipeSetId,
        version: 3,
        parentRecipeId: context.secondRecipe.id,
        feedbackId: context.secondFeedbackId,
        isSelected: true,
        safety: {
          level: "ALLOW",
          reasons: ["未命中已知安全规则。"],
          alternatives: [],
        },
      });

      expect(
        getRecipeVersionChain(read, { recipeId: context.thirdRecipe.id }).map(
          (recipe) => recipe.recipeId,
        ),
      ).toEqual([context.initialRecipe.id, context.secondRecipe.id, context.thirdRecipe.id]);
    } finally {
      context.database.cleanup();
    }
  });

  it("reads the original three-card set after adjustment sets have been added", () => {
    const context = createVersionedFixture();

    try {
      const initialRecipes = context.repository.findInitialRecipeSetBySession(context.sessionId);
      context.repository.setRecommendedRecipe(
        context.initialRecipe.recipeSetId,
        context.initialRecipe.id,
      );
      for (const recipe of initialRecipes) {
        context.database.sqlite
          .prepare(
            "INSERT INTO safety_decisions (id, recipe_id, level, rule_hits_json, engine_version, created_at) VALUES (?, ?, 'ALLOW', '[]', '1.0.0', 0)",
          )
          .run(randomUUID(), recipe.id);
      }
      context.database.sqlite
        .prepare(
          "INSERT INTO decision_events (id, session_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'recipe_set_generated', '生成初始三卡', ?, 0)",
        )
        .run(
          randomUUID(),
          context.sessionId,
          JSON.stringify({
            provenance: {
              recipeSetId: context.initialRecipe.recipeSetId,
              sourceMode: "fallback",
              degraded: false,
              stages: [
                {
                  phase: "generate",
                  attempt: 0,
                  sourceMode: "fallback",
                  degraded: false,
                  outcome: "accepted",
                },
              ],
            },
            sourceMode: "fallback",
            degraded: false,
          }),
        );

      const result = getRecipeSet(
        {
          read: () => ({
            findById: (id: string) =>
              new DrizzleSessionRepository(context.database.db).findById(id),
            listBySession: () => [
              {
                id: randomUUID(),
                sessionId: context.sessionId,
                rawName: "二锅头",
                canonicalName: "白酒",
                category: "spirit" as const,
                brand: "示例白酒",
                abv: 52,
                confidence: 0.95,
                confirmed: true,
                createdAt: new Date(0),
              },
            ],
            findSetBySession: (sessionId: string) => context.repository.findSetBySession(sessionId),
            findInitialRecipeSetBySession: (sessionId: string) =>
              context.repository.findInitialRecipeSetBySession(sessionId),
            listBySet: (recipeSetId: string) => context.repository.listBySet(recipeSetId),
            listSafetyDecisionsBySet: (recipeSetId: string) =>
              context.repository.listSafetyDecisionsBySet(recipeSetId),
            listDecisionEvents: (sessionId: string) =>
              context.repository.listDecisionEvents(sessionId),
          }),
        },
        { sessionId: context.sessionId },
      );

      expect(result.data.recipeSet.id).toBe(context.initialRecipe.recipeSetId);
      expect(result.data.recipeSet.recipes).toHaveLength(3);
    } finally {
      context.database.cleanup();
    }
  });

  it("rejects a selected recipe and parent recipe that cross the session boundary", () => {
    const context = createVersionedFixture();
    const otherSessionId = randomUUID();
    const otherSession = new DrizzleSessionRepository(context.database.db).create({
      id: otherSessionId,
    });
    expect(otherSession.id).toBe(otherSessionId);
    const otherFixtures = makeDomainFixtures();
    const otherInitialRecipe = createInitialSet(
      context.repository,
      otherSessionId,
      otherFixtures.recipes,
    )[0];
    if (otherInitialRecipe === undefined) {
      throw new Error("TEST_FIXTURE_INVALID");
    }

    try {
      context.database.sqlite
        .prepare("UPDATE sessions SET selected_recipe_id = ? WHERE id = ?")
        .run(otherInitialRecipe.id, context.sessionId);
      expect(() => context.repository.findCurrentRecipeBySession(context.sessionId)).toThrowError(
        RecipeDataIntegrityError,
      );

      context.database.sqlite
        .prepare("UPDATE recipes SET parent_recipe_id = ? WHERE id = ?")
        .run(otherInitialRecipe.id, context.secondRecipe.id);
      expect(() => context.repository.listRecipeVersionChain(context.thirdRecipe.id)).toThrowError(
        RecipeDataIntegrityError,
      );
    } finally {
      context.database.cleanup();
    }
  });

  it.each([
    {
      name: "a cycle",
      mutate: (context: VersionedFixture) => {
        context.database.sqlite
          .prepare("UPDATE recipes SET parent_recipe_id = ? WHERE id = ?")
          .run(context.thirdRecipe.id, context.secondRecipe.id);
      },
    },
    {
      name: "a missing parent",
      mutate: (context: VersionedFixture) => {
        context.database.sqlite.pragma("foreign_keys = OFF");
        context.database.sqlite
          .prepare("UPDATE recipes SET parent_recipe_id = ? WHERE id = ?")
          .run(randomUUID(), context.thirdRecipe.id);
        context.database.sqlite.pragma("foreign_keys = ON");
      },
    },
    {
      name: "a repeated version",
      mutate: (context: VersionedFixture) => {
        context.database.sqlite
          .prepare("UPDATE recipes SET version = 2 WHERE id = ?")
          .run(context.thirdRecipe.id);
      },
    },
    {
      name: "a skipped version",
      mutate: (context: VersionedFixture) => {
        context.database.sqlite
          .prepare("UPDATE recipes SET version = 4 WHERE id = ?")
          .run(context.thirdRecipe.id);
      },
    },
    {
      name: "a version retreat",
      mutate: (context: VersionedFixture) => {
        context.database.sqlite
          .prepare("UPDATE recipes SET version = 1 WHERE id = ?")
          .run(context.thirdRecipe.id);
      },
    },
    {
      name: "an adjustment set with more than one recipe",
      mutate: (context: VersionedFixture) => {
        const fixtures = makeDomainFixtures();
        context.repository.createRecipe({
          recipeSetId: context.secondRecipe.recipeSetId,
          sessionId: context.sessionId,
          candidate: { ...fixtures.recipes[1], id: RecipeIdSchema.parse(randomUUID()) },
          version: 2,
          parentRecipeId: context.initialRecipe.id,
          feedbackId: context.firstFeedbackId,
        });
      },
    },
  ])("rejects $name in the version chain", ({ mutate }) => {
    const context = createVersionedFixture();

    try {
      mutate(context);
      expect(() => context.repository.listRecipeVersionChain(context.thirdRecipe.id)).toThrowError(
        RecipeDataIntegrityError,
      );
    } finally {
      context.database.cleanup();
    }
  });
});

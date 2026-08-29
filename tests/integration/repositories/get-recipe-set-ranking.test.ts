import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { createTestDatabase } from "@/tests/helpers/test-database";
import { DrizzleRecipeRepository } from "@/src/infrastructure/repositories/drizzle-recipe-repository";
import { DrizzleSessionRepository } from "@/src/infrastructure/repositories/drizzle-session-repository";
import { getRecipeSet } from "@/src/application/get-recipe-set";
import { evaluateRecipeCandidateSafety } from "@/src/application/repair-blocked-recipe";
import { evaluateSafety } from "@/src/safety/evaluate-safety";

const PREFERENCES = {
  sweetness: 4,
  acidity: 4,
  alcoholIntensity: 3,
  body: 4,
} as const;

const ENGINE_VERSION = "1.0.0";

// 偏好 {4,4,3,4} 下口味距离：B=0、C=5、A=3；
// A 标记 experimental 触发 SAFETY_EXPERIMENTAL WARN（安全惩罚 20）→ 总分 B=0、C=5、A=23，
// 期望完整 recommendation ranking 为 [B, C, A]。
describe("getRecipeSet full recommendation ranking", () => {
  it("returns the full ranked order [B, C, A] even though the repository persists and reads A/B/C", () => {
    const context = createTestDatabase();
    const fixtures = makeDomainFixtures();
    const sessionId = fixtures.ids.sessionId;
    const [baseA, baseB, baseC] = fixtures.recipes;
    if (baseA === undefined || baseB === undefined || baseC === undefined) {
      throw new Error("TEST_FIXTURE_INVALID");
    }
    // fixtures 默认三卡完全同质，会触发 DUPLICATE_CANDIDATE；此处构造可区分的候选。
    const recipeA = { ...baseA };
    const recipeB = {
      ...baseB,
      materials: [{ name: "白酒", amountMl: 45, unit: "ml" }],
      steps: [{ order: 1, instruction: "先降温再分次加入白酒", isPhotoCheckpoint: false }],
    };
    const recipeC = {
      ...baseC,
      materials: [
        { name: "白酒", amountMl: 30, unit: "ml" },
        { name: "柠檬", amountMl: 15, unit: "ml" },
      ],
      missingIngredients: ["柠檬"],
      steps: [{ order: 1, instruction: "加入柠檬片并轻轻搅拌", isPhotoCheckpoint: false }],
    };

    try {
      const sessionRepository = new DrizzleSessionRepository(context.db);
      sessionRepository.create({ id: sessionId });
      // 直接写入会话偏好，绕开 updateVersion 的 mutation lease 机制。
      context.sqlite
        .prepare("UPDATE sessions SET preferences_json = ? WHERE id = ?")
        .run(JSON.stringify(PREFERENCES), sessionId);

      const repository = new DrizzleRecipeRepository(context.db);
      const recipeSetId = randomUUID();
      repository.createRecipeSet({
        id: recipeSetId,
        sessionId,
        sourceMode: "fallback",
      });
      // 落库顺序为 A/B/C；A 标记 experimental 以产生确定性 WARN。
      const persisted = [
        { ...recipeA, experimental: true, safetyLevel: "WARN" as const },
        recipeB,
        recipeC,
      ].map((candidate) =>
        repository.createRecipe({
          recipeSetId,
          sessionId,
          candidate,
          version: 1,
          parentRecipeId: null,
          feedbackId: null,
        }),
      );
      repository.setRecommendedRecipe(recipeSetId, recipeB.id);

      const confirmedIngredients = [
        {
          id: randomUUID(),
          sessionId,
          rawName: "二锅头",
          canonicalName: "白酒",
          category: "spirit" as const,
          brand: "示例白酒",
          abv: 52,
          confidence: 0.95,
          confirmed: true,
          createdAt: new Date(0),
        },
      ];

      for (const candidate of [
        { ...recipeA, experimental: true },
        recipeB,
        recipeC,
      ]) {
        const decision = evaluateRecipeCandidateSafety(
          candidate,
          confirmedIngredients,
          evaluateSafety,
        ).safetyDecision;
        repository.createSafetyDecision({
          recipeId: candidate.id,
          level: decision.level,
          ruleHits: decision.hits,
          engineVersion: ENGINE_VERSION,
        });
      }

      context.sqlite
        .prepare(
          "INSERT INTO decision_events (id, session_id, event_type, summary, metadata_json, created_at) VALUES (?, ?, 'recipe_set_generated', '生成初始三卡', ?, 0)",
        )
        .run(
          randomUUID(),
          sessionId,
          JSON.stringify({
            provenance: {
              recipeSetId,
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

      // 前置事实：Repository 实际读取顺序仍是落库的 A/B/C。
      const rawOrder = repository.listBySet(recipeSetId).map((recipe) => recipe.id);
      expect(rawOrder).toEqual([recipeA.id, recipeB.id, recipeC.id]);

      const result = getRecipeSet(
        {
          read: () => ({
            findById: (id: string) => sessionRepository.findById(id),
            listBySession: () => confirmedIngredients,
            findSetBySession: (id: string) => repository.findSetBySession(id),
            findInitialRecipeSetBySession: (id: string) =>
              repository.findInitialRecipeSetBySession(id),
            listBySet: (id: string) => repository.listBySet(id),
            listSafetyDecisionsBySet: (id: string) => repository.listSafetyDecisionsBySet(id),
            listDecisionEvents: (id: string) => repository.listDecisionEvents(id),
          }),
        },
        { sessionId },
      );

      expect(result.data.recipeSet.recommendedRecipeId).toBe(recipeB.id);
      expect(result.data.recipeSet.recipes.map((recipe) => recipe.id)).toEqual([
        recipeB.id,
        recipeC.id,
        recipeA.id,
      ]);
      expect(result.data.recipeSet.recipes[0]?.title).toBe(recipeB.title);
    } finally {
      context.cleanup();
    }
  });
});

import { randomUUID } from "node:crypto";

export function makeDomainFixtures() {
  const sessionId = randomUUID();
  const requestId = randomUUID();
  const recipeIds = [randomUUID(), randomUUID(), randomUUID()] as const;

  const tasteProfile = {
    sweetness: 3,
    acidity: 2,
    alcoholIntensity: 4,
    body: 3,
  } as const;

  const session = {
    id: sessionId,
    state: "PREFERENCES" as const,
    version: 0,
  };

  const ingredient = {
    rawName: "二锅头",
    canonicalName: "白酒",
    category: "spirit" as const,
    brand: null,
    abv: null,
    confidence: 0.72,
    confirmed: false,
  };

  const makeCandidate = (id: string, strategy: "A_CONSERVATIVE" | "B_CREATIVE" | "C_UPGRADE") => ({
    id,
    strategy,
    title: `${strategy} 调饮`,
    fitReason: "适合当前口味偏好",
    differenceReason: `${strategy} 通过手法和比例形成不同体验`,
    materials: [{ name: "白酒", amountMl: 30, unit: "ml" }],
    steps: [{ order: 1, instruction: "加入材料并轻轻搅拌", isPhotoCheckpoint: false }],
    estimatedAbv: 12,
    safetyLevel: "ALLOW" as const,
    experimental: false,
    missingIngredients: [],
  });

  const recipes = [
    makeCandidate(recipeIds[0], "A_CONSERVATIVE"),
    makeCandidate(recipeIds[1], "B_CREATIVE"),
    makeCandidate(recipeIds[2], "C_UPGRADE"),
  ];

  return {
    ids: { sessionId, requestId, recipeIds },
    tasteProfile,
    session,
    ingredient,
    recipes,
    recipeSet: {
      recipes,
      recommendedRecipeId: recipeIds[0],
    },
    feedback: {
      rating: 4,
      accepted: false,
      deltas: {
        sweetness: 1,
        acidity: 0,
        alcoholIntensity: -1,
        body: 0,
      },
      notes: "酒感略强，希望更清爽。",
      finalImageId: null,
    },
    successEnvelope: {
      data: tasteProfile,
      session,
    },
    errorEnvelope: {
      error: {
        code: "INVALID_REQUEST",
        message: "请求格式不正确",
        retryable: false,
      },
    },
  };
}

import { describe, expect, it } from "vitest";

import { createRecipeId } from "@/src/domain/id";
import {
  RecipeCandidateSchema,
  RecipeCandidateSetSchema,
  type RecipeCandidate,
  type RecipeCandidateSet,
} from "@/src/domain/recipe";
import { FeedbackSchema } from "@/src/domain/feedback";
import { FallbackRecipeProvider } from "@/src/infrastructure/providers/fallback-recipe-provider";
import { QwenRecipeProvider } from "@/src/infrastructure/providers/qwen-recipe-provider";
import { evaluateRecipeCandidateSafety } from "@/src/application/repair-blocked-recipe";
import { evaluateSafety } from "@/src/safety/evaluate-safety";
import type {
  QwenCompletionClient,
  QwenCompletionRequest,
  RecipeAdjustmentInput,
  RecipeGenerationInput,
  RecipeProvider,
} from "@/src/providers/recipe-provider";

const generationInput: RecipeGenerationInput = {
  preferences: {
    sweetness: 3,
    acidity: 2,
    alcoholIntensity: 4,
    body: 3,
  },
  ingredients: [
    {
      rawName: "二锅头",
      canonicalName: "白酒",
      category: "spirit",
      brand: "示例酒",
      abv: 42,
      confidence: 1,
      confirmed: true,
    },
    {
      rawName: "苏打水",
      canonicalName: "苏打水",
      category: "mixer",
      brand: null,
      abv: null,
      confidence: 1,
      confirmed: true,
    },
  ],
};

const adjustmentInput = (currentRecipe: RecipeCandidate): RecipeAdjustmentInput => ({
  preferences: generationInput.preferences,
  currentRecipe,
  confirmedMaterialNames: generationInput.ingredients
    .filter((ingredient) => ingredient.confirmed)
    .map((ingredient) => ingredient.canonicalName),
  feedback: FeedbackSchema.parse({
    rating: 3,
    accepted: false,
    deltas: {
      sweetness: 1,
      acidity: 0,
      alcoholIntensity: -1,
      body: 0,
    },
    notes: "希望更甜、更清爽。",
    finalImageId: null,
  }),
});

function staticCandidate(
  strategy: RecipeCandidate["strategy"],
  safetyLevel: RecipeCandidate["safetyLevel"] = "ALLOW",
): RecipeCandidate {
  const materialByStrategy = {
    A_CONSERVATIVE: [
      { name: "白酒", amountMl: 30, unit: "ml" as const },
      { name: "苏打水", amountMl: 90, unit: "ml" as const },
    ],
    B_CREATIVE: [
      { name: "白酒", amountMl: 35, unit: "ml" as const },
      { name: "苏打水", amountMl: 85, unit: "ml" as const },
    ],
    C_UPGRADE: [
      { name: "白酒", amountMl: 30, unit: "ml" as const },
      { name: "苏打水", amountMl: 80, unit: "ml" as const },
      { name: "柠檬", amountMl: 10, unit: "ml" as const },
    ],
  } as const;

  return RecipeCandidateSchema.parse({
    id: createRecipeId(),
    strategy,
    title: `${strategy} 静态方案`,
    fitReason: "适合当前口味偏好",
    differenceReason: `${strategy} 通过比例和手法形成不同体验`,
    materials: materialByStrategy[strategy],
    steps: [
      {
        order: 1,
        isPhotoCheckpoint: false,
        instruction:
          strategy === "A_CONSERVATIVE"
            ? "加入白酒和苏打水，轻轻搅拌。"
            : strategy === "B_CREATIVE"
              ? "先冷藏苏打水，再沿杯壁加入白酒。"
              : "加入柠檬和冰块后轻轻搅拌。",
      },
    ],
    estimatedAbv: 10,
    safetyLevel,
    experimental: false,
    missingIngredients: strategy === "C_UPGRADE" ? ["柠檬"] : [],
  });
}

function staticCandidateSet(
  safetyLevel: RecipeCandidate["safetyLevel"] = "ALLOW",
): RecipeCandidateSet {
  const recipes = [
    staticCandidate("A_CONSERVATIVE", safetyLevel),
    staticCandidate("B_CREATIVE"),
    staticCandidate("C_UPGRADE"),
  ];

  return RecipeCandidateSetSchema.parse({
    recipes,
    recommendedRecipeId: recipes[0].id,
  });
}

function staticCandidateSetWithUncontrolledCMaterial(): RecipeCandidateSet {
  const validSet = staticCandidateSet();
  return RecipeCandidateSetSchema.parse({
    recipes: validSet.recipes.map((recipe) =>
      recipe.strategy === "C_UPGRADE"
        ? {
            ...recipe,
            materials: [
              { name: "白酒", amountMl: 30, unit: "ml" },
              { name: "苏打水", amountMl: 80, unit: "ml" },
              { name: "咖啡", amountMl: 20, unit: "ml" },
            ],
            missingIngredients: [],
          }
        : recipe,
    ),
    recommendedRecipeId: validSet.recommendedRecipeId,
  });
}

function staticCandidateSetWithUncontrolledABMaterial(): RecipeCandidateSet {
  const validSet = staticCandidateSet();
  return RecipeCandidateSetSchema.parse({
    recipes: validSet.recipes.map((recipe) =>
      recipe.strategy === "A_CONSERVATIVE"
        ? {
            ...recipe,
            materials: [
              { name: "咖啡", amountMl: 30, unit: "ml" },
              { name: "苏打水", amountMl: 90, unit: "ml" },
            ],
            missingIngredients: [],
          }
        : recipe,
    ),
    recommendedRecipeId: validSet.recommendedRecipeId,
  });
}

function staticCandidateSetWithThreeAddedCMaterials(): RecipeCandidateSet {
  const validSet = staticCandidateSet();
  return RecipeCandidateSetSchema.parse({
    recipes: validSet.recipes.map((recipe) =>
      recipe.strategy === "C_UPGRADE"
        ? {
            ...recipe,
            materials: [
              { name: "白酒", amountMl: 30, unit: "ml" },
              { name: "苏打水", amountMl: 80, unit: "ml" },
              { name: "柠檬", amountMl: 10, unit: "ml" },
              { name: "冰块", amountMl: 60, unit: "ml" },
              { name: "蜂蜜", amountMl: 5, unit: "ml" },
            ],
            missingIngredients: [],
          }
        : recipe,
    ),
    recommendedRecipeId: validSet.recommendedRecipeId,
  });
}

class StaticCompletionClient implements QwenCompletionClient {
  readonly requests: QwenCompletionRequest[] = [];

  constructor(private readonly responses: readonly (string | Error)[]) {}

  async complete(request: QwenCompletionRequest): Promise<string> {
    this.requests.push(request);
    const response = this.responses[this.requests.length - 1];
    if (response instanceof Error) {
      throw response;
    }
    if (response === undefined) {
      throw new Error("No static response configured");
    }
    return response;
  }
}

class NeverResolvingCompletionClient implements QwenCompletionClient {
  readonly requests: QwenCompletionRequest[] = [];

  complete(request: QwenCompletionRequest): Promise<string> {
    this.requests.push(request);
    return new Promise<string>(() => undefined);
  }
}

class AbortAwareNeverResolvingCompletionClient implements QwenCompletionClient {
  readonly requests: QwenCompletionRequest[] = [];
  signal: AbortSignal | undefined;

  complete(request: QwenCompletionRequest): Promise<string> {
    this.requests.push(request);
    this.signal = (request as QwenCompletionRequest & { signal?: AbortSignal }).signal;
    return new Promise<string>((_, reject) => {
      this.signal?.addEventListener(
        "abort",
        () => reject(new Error("ABORTED_BY_PROVIDER_TIMEOUT")),
        { once: true },
      );
    });
  }
}

function qwenProvider(
  client: QwenCompletionClient,
  fallback = new FallbackRecipeProvider(),
  timeoutMs = 1500,
): QwenRecipeProvider {
  return new QwenRecipeProvider({
    client,
    model: "qwen-test-fixture",
    timeoutMs,
    fallback,
  });
}

async function assertRecipeProviderContract(provider: RecipeProvider): Promise<void> {
  const generated = await provider.generate(generationInput);

  expect(RecipeCandidateSetSchema.safeParse(generated).success).toBe(true);
  expect(generated.recipes.map((recipe) => recipe.strategy).sort()).toEqual([
    "A_CONSERVATIVE",
    "B_CREATIVE",
    "C_UPGRADE",
  ]);
  expect(new Set(generated.recipes.map((recipe) => recipe.id)).size).toBe(3);

  const upgrade = generated.recipes.find((recipe) => recipe.strategy === "C_UPGRADE");
  expect(upgrade?.missingIngredients.length).toBeLessThanOrEqual(2);

  const adjusted = await provider.adjust(adjustmentInput(generated.recipes[0]));
  expect(RecipeCandidateSchema.safeParse(adjusted).success).toBe(true);
  expect(adjusted).not.toHaveProperty("recipes");
}

describe("RecipeProvider contract", () => {
  it("fallback returns exactly A/B/C and one adjustment candidate", async () => {
    await assertRecipeProviderContract(new FallbackRecipeProvider());
  });

  it("applies every nonzero adjustment to confirmed spirits and keeps the result safety-valid", async () => {
    const spiritNames = ["牛栏山", generationInput.ingredients[0]?.canonicalName ?? "白酒"];
    const adjustmentCases = [
      { dimension: "sweetness" as const, delta: 1 as const },
      { dimension: "acidity" as const, delta: 1 as const },
      { dimension: "alcoholIntensity" as const, delta: -2 as const },
      { dimension: "body" as const, delta: 1 as const },
    ];

    for (const spiritName of spiritNames) {
      const confirmedIngredients = [
        {
          rawName: spiritName,
          canonicalName: spiritName,
          category: "spirit" as const,
          brand: null,
          abv: 42,
          confidence: 1,
          confirmed: true,
        },
        {
          rawName: "苏打水",
          canonicalName: "苏打水",
          category: "mixer" as const,
          brand: null,
          abv: null,
          confidence: 1,
          confirmed: true,
        },
      ];
      const currentRecipe = RecipeCandidateSchema.parse({
        ...staticCandidate("A_CONSERVATIVE"),
        materials: [
          { name: spiritName, amountMl: 30, unit: "ml" },
          { name: "苏打水", amountMl: 90, unit: "ml" },
        ],
      });

      for (const adjustmentCase of adjustmentCases) {
        const feedback = FeedbackSchema.parse({
          ...adjustmentInput(currentRecipe).feedback,
          deltas: {
            sweetness: adjustmentCase.dimension === "sweetness" ? adjustmentCase.delta : 0,
            acidity: adjustmentCase.dimension === "acidity" ? adjustmentCase.delta : 0,
            alcoholIntensity:
              adjustmentCase.dimension === "alcoholIntensity" ? adjustmentCase.delta : 0,
            body: adjustmentCase.dimension === "body" ? adjustmentCase.delta : 0,
          },
        });
        const adjusted = await new FallbackRecipeProvider().adjust({
          ...adjustmentInput(currentRecipe),
          confirmedMaterialNames: [spiritName, "苏打水"],
          feedback,
        });

        expect(RecipeCandidateSchema.safeParse(adjusted).success).toBe(true);
        expect(adjusted.materials).not.toEqual(currentRecipe.materials);
        if (adjustmentCase.dimension === "alcoholIntensity") {
          const currentSpirit = currentRecipe.materials.find((item) => item.name === spiritName);
          const adjustedSpirit = adjusted.materials.find((item) => item.name === spiritName);
          const currentDilution = currentRecipe.materials.find((item) => item.name === "苏打水");
          const adjustedDilution = adjusted.materials.find((item) => item.name === "苏打水");
          expect(
            (adjustedSpirit?.amountMl ?? 0) < (currentSpirit?.amountMl ?? 0) ||
              (adjustedDilution?.amountMl ?? 0) > (currentDilution?.amountMl ?? 0),
          ).toBe(true);
        }

        const safety = evaluateRecipeCandidateSafety(
          adjusted,
          confirmedIngredients,
          evaluateSafety,
        );
        expect(RecipeCandidateSchema.safeParse(safety.candidate).success).toBe(true);
        expect(safety.safetyDecision.level).not.toBe("BLOCK");
      }
    }
  });

  it("Qwen adapter and fallback both satisfy the shared Zod output schemas", async () => {
    const client = new StaticCompletionClient([
      JSON.stringify(staticCandidateSet()),
      JSON.stringify(staticCandidate("A_CONSERVATIVE")),
    ]);

    await assertRecipeProviderContract(qwenProvider(client));
    expect(client.requests).toHaveLength(2);
  });

  it("reports qwen provenance for a direct generate success", async () => {
    const client = new StaticCompletionClient([JSON.stringify(staticCandidateSet())]);

    const result = await qwenProvider(client).generateWithOutcome(generationInput);

    expect(result.sourceMode).toBe("qwen");
    expect(result.degraded).toBe(false);
    expect(RecipeCandidateSetSchema.safeParse(result.value).success).toBe(true);
  });

  it("keeps qwen provenance when a repair prompt fixes invalid generate JSON", async () => {
    const client = new StaticCompletionClient(["not-json", JSON.stringify(staticCandidateSet())]);

    const result = await qwenProvider(client).generateWithOutcome(generationInput);

    expect(result.sourceMode).toBe("qwen");
    expect(result.degraded).toBe(false);
    expect(client.requests).toHaveLength(2);
    expect(client.requests[1].prompt).toContain("修复");
    expect(
      (result as unknown as { provenanceStages?: readonly Record<string, unknown>[] })
        .provenanceStages,
    ).toEqual([
      expect.objectContaining({
        phase: "generate",
        attempt: 0,
        outcome: "invalid_output",
        sourceMode: "qwen",
        degraded: false,
      }),
      expect.objectContaining({
        phase: "generate",
        attempt: 1,
        outcome: "repair_accepted",
        sourceMode: "qwen",
        degraded: false,
      }),
    ]);
  });

  it("reports fallback provenance when generate repair still fails", async () => {
    const client = new StaticCompletionClient(["not-json", "still-not-json"]);

    const result = await qwenProvider(client).generateWithOutcome(generationInput);

    expect(result.sourceMode).toBe("fallback");
    expect(result.degraded).toBe(true);
    expect(client.requests).toHaveLength(2);
    expect(
      (result as unknown as { provenanceStages?: readonly Record<string, unknown>[] })
        .provenanceStages,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "generate", outcome: "invalid_output" }),
        expect.objectContaining({ phase: "generate", outcome: "repair_failed" }),
        expect.objectContaining({
          phase: "fallback",
          outcome: "fallback",
          sourceMode: "fallback",
          degraded: true,
        }),
      ]),
    );
  });

  it("reports fallback provenance when adjust repair still fails", async () => {
    const currentRecipe = staticCandidate("C_UPGRADE");
    const client = new StaticCompletionClient(["not-json", "still-not-json"]);

    const result = await qwenProvider(client).adjustWithOutcome(adjustmentInput(currentRecipe));

    expect(result.sourceMode).toBe("fallback");
    expect(result.degraded).toBe(true);
    expect(result.value.strategy).toBe("C_UPGRADE");
    expect(client.requests).toHaveLength(2);
  });

  it("reports fallback provenance after a timeout without leaking into a fake qwen success", async () => {
    const client = new StaticCompletionClient([new Error("timeout")]);

    const result = await qwenProvider(client).generateWithOutcome(generationInput);

    expect(result.sourceMode).toBe("fallback");
    expect(result.degraded).toBe(true);
    expect(client.requests).toHaveLength(1);
    expect(
      (result as unknown as { provenanceStages?: readonly Record<string, unknown>[] })
        .provenanceStages,
    ).toEqual([
      expect.objectContaining({
        phase: "generate",
        attempt: 0,
        outcome: "timeout",
        sourceMode: "fallback",
        degraded: true,
      }),
    ]);
  });

  it("adjust repairs invalid JSON exactly once before accepting the repaired candidate", async () => {
    const currentRecipe = staticCandidate("C_UPGRADE");
    const client = new StaticCompletionClient(["not-json", JSON.stringify(currentRecipe)]);

    const result = await qwenProvider(client).adjust(adjustmentInput(currentRecipe));

    expect(result.strategy).toBe("C_UPGRADE");
    expect(client.requests).toHaveLength(2);
    expect(client.requests[1].prompt).toContain("修复");
  });

  it("adjust falls back after a second invalid response", async () => {
    const currentRecipe = staticCandidate("C_UPGRADE");
    const client = new StaticCompletionClient(["not-json", "still-not-json"]);

    const result = await qwenProvider(client).adjust(adjustmentInput(currentRecipe));

    expect(RecipeCandidateSchema.safeParse(result).success).toBe(true);
    expect(result.strategy).toBe("C_UPGRADE");
    expect(client.requests).toHaveLength(2);
  });

  it("repairs an A/B adjust response with a material outside the confirmed baseline", async () => {
    const currentRecipe = staticCandidate("A_CONSERVATIVE");
    const uncontrolled = {
      ...currentRecipe,
      materials: [
        { name: "咖啡", amountMl: 30, unit: "ml" as const },
        { name: "苏打水", amountMl: 90, unit: "ml" as const },
      ],
    } satisfies RecipeCandidate;
    const client = new StaticCompletionClient([
      JSON.stringify(uncontrolled),
      JSON.stringify(currentRecipe),
    ]);

    const result = await qwenProvider(client).adjust(adjustmentInput(currentRecipe));

    expect(result.strategy).toBe("A_CONSERVATIVE");
    expect(result.materials.map((material) => material.name)).not.toContain("咖啡");
    expect(client.requests).toHaveLength(2);
  });

  it("repairs a C adjust response that exceeds two cumulative additions beyond confirmed materials", async () => {
    const currentRecipe = {
      ...staticCandidate("C_UPGRADE"),
      materials: [
        ...staticCandidate("C_UPGRADE").materials,
        { name: "冰块", amountMl: 60, unit: "ml" as const },
      ],
      missingIngredients: ["柠檬", "冰块"],
    } satisfies RecipeCandidate;
    const uncontrolled = {
      ...currentRecipe,
      materials: [...currentRecipe.materials, { name: "蜂蜜", amountMl: 5, unit: "ml" as const }],
      missingIngredients: [],
    } satisfies RecipeCandidate;
    const client = new StaticCompletionClient([
      JSON.stringify(uncontrolled),
      JSON.stringify(staticCandidate("C_UPGRADE")),
    ]);

    const result = await qwenProvider(client).adjust(adjustmentInput(currentRecipe));

    expect(result.strategy).toBe("C_UPGRADE");
    expect(result.materials.map((material) => material.name)).not.toContain("蜂蜜");
    expect(client.requests).toHaveLength(2);
  });

  it("accepts a legal C adjustment within the confirmed baseline and two-material limit", async () => {
    const currentRecipe = staticCandidate("C_UPGRADE");
    const legalAdjustment = {
      ...currentRecipe,
      materials: currentRecipe.materials.map((item) =>
        item.name === "柠檬" ? { ...item, amountMl: 15 } : item,
      ),
    } satisfies RecipeCandidate;
    const client = new StaticCompletionClient([JSON.stringify(legalAdjustment)]);

    const result = await qwenProvider(client).adjust(adjustmentInput(currentRecipe));

    expect(result.strategy).toBe("C_UPGRADE");
    expect(result.materials.find((item) => item.name === "柠檬")?.amountMl).toBe(15);
    expect(client.requests).toHaveLength(1);
  });

  it("repairs an adjust response that changes the current strategy", async () => {
    const currentRecipe = staticCandidate("C_UPGRADE");
    const client = new StaticCompletionClient([
      JSON.stringify(staticCandidate("A_CONSERVATIVE")),
      JSON.stringify(currentRecipe),
    ]);

    const result = await qwenProvider(client).adjust(adjustmentInput(currentRecipe));

    expect(result.strategy).toBe("C_UPGRADE");
    expect(client.requests).toHaveLength(2);
  });

  it("repairs an adjust response with an uncontrolled C material even when missingIngredients is empty", async () => {
    const currentRecipe = staticCandidate("C_UPGRADE");
    const uncontrolled = {
      ...currentRecipe,
      materials: [
        { name: "白酒", amountMl: 30, unit: "ml" as const },
        { name: "苏打水", amountMl: 80, unit: "ml" as const },
        { name: "咖啡", amountMl: 20, unit: "ml" as const },
      ],
      missingIngredients: [],
    } satisfies RecipeCandidate;
    const client = new StaticCompletionClient([
      JSON.stringify(uncontrolled),
      JSON.stringify(currentRecipe),
    ]);

    const result = await qwenProvider(client).adjust(adjustmentInput(currentRecipe));

    expect(result.strategy).toBe("C_UPGRADE");
    expect(result.materials.map((material) => material.name)).not.toContain("咖啡");
    expect(client.requests).toHaveLength(2);
  });

  it("falls back when a completion client never resolves before timeout", async () => {
    const client = new NeverResolvingCompletionClient();

    const result = await qwenProvider(client, new FallbackRecipeProvider(), 20).generate(
      generationInput,
    );

    expect(RecipeCandidateSetSchema.safeParse(result).success).toBe(true);
    expect(client.requests).toHaveLength(1);
  });

  it("aborts the real completion signal before timeout fallback resolves", async () => {
    const client = new AbortAwareNeverResolvingCompletionClient();

    const result = await qwenProvider(client, new FallbackRecipeProvider(), 20).generate(
      generationInput,
    );

    expect(RecipeCandidateSetSchema.safeParse(result).success).toBe(true);
    expect(client.requests).toHaveLength(1);
    expect(client.signal).toBeDefined();
    expect(client.signal?.aborted).toBe(true);
  });

  it("keeps model safety as an untrusted hint instead of making a Safety decision", async () => {
    const client = new StaticCompletionClient([JSON.stringify(staticCandidateSet("BLOCK"))]);

    const result = await qwenProvider(client).generate(generationInput);

    expect(result.recipes.find((recipe) => recipe.strategy === "A_CONSERVATIVE")?.safetyLevel).toBe(
      "BLOCK",
    );
    expect(client.requests[0].prompt).toContain("最终 Safety 引擎裁决");
  });

  it("repairs invalid JSON exactly once before accepting the repaired set", async () => {
    const client = new StaticCompletionClient(["not-json", JSON.stringify(staticCandidateSet())]);

    const result = await qwenProvider(client).generate(generationInput);

    expect(RecipeCandidateSetSchema.safeParse(result).success).toBe(true);
    expect(client.requests).toHaveLength(2);
    expect(client.requests[1].prompt).toContain("修复");
  });

  it("repairs generated A/B materials outside the confirmed names", async () => {
    const client = new StaticCompletionClient([
      JSON.stringify(staticCandidateSetWithUncontrolledABMaterial()),
      JSON.stringify(staticCandidateSet()),
    ]);

    const result = await qwenProvider(client).generate(generationInput);

    expect(
      result.recipes
        .find((recipe) => recipe.strategy === "A_CONSERVATIVE")
        ?.materials.map((material) => material.name),
    ).not.toContain("咖啡");
    expect(client.requests).toHaveLength(2);
  });

  it("repairs generated C when actual added materials exceed two", async () => {
    const client = new StaticCompletionClient([
      JSON.stringify(staticCandidateSetWithThreeAddedCMaterials()),
      JSON.stringify(staticCandidateSet()),
    ]);

    const result = await qwenProvider(client).generate(generationInput);

    expect(
      result.recipes
        .find((recipe) => recipe.strategy === "C_UPGRADE")
        ?.materials.map((material) => material.name),
    ).toEqual(["白酒", "苏打水", "柠檬"]);
    expect(client.requests).toHaveLength(2);
  });

  it("repairs adjust C when it adds more than two new material names", async () => {
    const currentRecipe = staticCandidate("C_UPGRADE");
    const uncontrolled = {
      ...currentRecipe,
      materials: [
        ...currentRecipe.materials,
        { name: "冰块", amountMl: 60, unit: "ml" as const },
        { name: "蜂蜜", amountMl: 5, unit: "ml" as const },
        { name: "薄荷", amountMl: 10, unit: "ml" as const },
      ],
      missingIngredients: [],
    } satisfies RecipeCandidate;
    const client = new StaticCompletionClient([
      JSON.stringify(uncontrolled),
      JSON.stringify(currentRecipe),
    ]);

    const result = await qwenProvider(client).adjust(adjustmentInput(currentRecipe));

    expect(result.materials.map((material) => material.name)).toEqual(["白酒", "苏打水", "柠檬"]);
    expect(client.requests).toHaveLength(2);
  });

  it("repairs a generated C candidate with an uncontrolled material", async () => {
    const client = new StaticCompletionClient([
      JSON.stringify(staticCandidateSetWithUncontrolledCMaterial()),
      JSON.stringify(staticCandidateSet()),
    ]);

    const result = await qwenProvider(client).generate(generationInput);

    expect(
      result.recipes
        .find((recipe) => recipe.strategy === "C_UPGRADE")
        ?.materials.map((material) => material.name),
    ).not.toContain("咖啡");
    expect(client.requests).toHaveLength(2);
  });

  it("falls back after a second invalid response", async () => {
    const client = new StaticCompletionClient(["not-json", "still-not-json"]);

    const result = await qwenProvider(client).generate(generationInput);

    expect(RecipeCandidateSetSchema.safeParse(result).success).toBe(true);
    expect(result.recipes.map((recipe) => recipe.strategy).sort()).toEqual([
      "A_CONSERVATIVE",
      "B_CREATIVE",
      "C_UPGRADE",
    ]);
    expect(client.requests).toHaveLength(2);
  });

  it("falls back after a timeout without a real API call or repair loop", async () => {
    const client = new StaticCompletionClient([new Error("timeout")]);

    const result = await qwenProvider(client).generate(generationInput);

    expect(RecipeCandidateSetSchema.safeParse(result).success).toBe(true);
    expect(client.requests).toHaveLength(1);
  });
});

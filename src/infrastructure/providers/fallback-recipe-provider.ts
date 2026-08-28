import { createRecipeId } from "@/src/domain/id";
import type { DetectedIngredient, IngredientCategory } from "@/src/domain/ingredient";
import type { RecipeCandidate, RecipeMaterial, RecipeStep } from "@/src/domain/recipe";
import { type RecipeCandidateSet } from "@/src/domain/recipe";
import {
  type OutcomeAwareRecipeProvider,
  RecipeAdjustmentInputSchema,
  RecipeGenerationInputSchema,
  type RecipeProviderOutcome,
  type RecipeAdjustmentInput,
  type RecipeGenerationInput,
} from "@/src/providers/recipe-provider";
import { rankRecommendation } from "@/src/agent/rank-recommendation";
import { buildAdjustmentConstraints } from "@/src/agent/build-adjustment-constraints";
import {
  FALLBACK_COMBINATIONS,
  UPGRADE_MISSING_INGREDIENTS,
  type UpgradeMissingIngredient,
} from "@/src/agent/fallback/catalog";
import {
  validateAdjustedCandidate,
  validateCandidateSet,
} from "@/src/agent/validate-candidate-set";

const SAFE_SUPPORT_CATEGORIES: readonly IngredientCategory[] = [
  "mixer",
  "tea",
  "fruit",
  "sweetener",
  "herb",
  "ice",
];

export interface FallbackRecipeProviderOptions {
  createId?: () => RecipeCandidate["id"];
}

export class RecipeProviderInputError extends Error {
  readonly code = "INVALID_RECIPE_INPUT";

  constructor(message: string) {
    super(message);
    this.name = "RecipeProviderInputError";
  }
}

function material(name: string, amountMl: number): RecipeMaterial {
  return { name, amountMl, unit: "ml" };
}

function sumVolume(materials: readonly RecipeMaterial[]): number {
  return materials.reduce((total, item) => total + item.amountMl, 0);
}

function estimateAbv(
  materials: readonly RecipeMaterial[],
  spirit: DetectedIngredient,
): number | null {
  if (spirit.abv === null) {
    return null;
  }

  const spiritMaterial = materials.find((item) => item.name === spirit.canonicalName);
  if (!spiritMaterial) {
    return null;
  }

  const totalVolume = sumVolume(materials);
  return totalVolume > 0
    ? Number(((spirit.abv * spiritMaterial.amountMl) / totalVolume).toFixed(1))
    : null;
}

function selectConfirmedIngredients(input: RecipeGenerationInput): {
  spirit: DetectedIngredient;
  supports: DetectedIngredient[];
} {
  const confirmed = input.ingredients.filter((ingredient) => ingredient.confirmed);
  const spirit = confirmed.find((ingredient) => ingredient.category === "spirit");
  if (!spirit) {
    throw new RecipeProviderInputError("A confirmed spirit is required before recipe generation");
  }

  return {
    spirit,
    supports: confirmed
      .filter(
        (ingredient) =>
          ingredient !== spirit && SAFE_SUPPORT_CATEGORIES.includes(ingredient.category),
      )
      .slice(0, 2),
  };
}

function findCombination(
  supports: readonly DetectedIngredient[],
): (typeof FALLBACK_COMBINATIONS)[number] {
  const names = new Set(supports.map((ingredient) => ingredient.canonicalName));
  return (
    FALLBACK_COMBINATIONS.find((combination) =>
      combination.names.some((name) => names.has(name)),
    ) ?? FALLBACK_COMBINATIONS[0]
  );
}

function chooseMissingIngredients(
  supports: readonly DetectedIngredient[],
  combination: (typeof FALLBACK_COMBINATIONS)[number],
): UpgradeMissingIngredient[] {
  const confirmedNames = new Set(supports.map((ingredient) => ingredient.canonicalName));
  const preferred = [...combination.defaultMissing, ...UPGRADE_MISSING_INGREDIENTS];
  return [...new Set(preferred)].filter((name) => !confirmedNames.has(name)).slice(0, 2);
}

function missingMaterialAmount(name: UpgradeMissingIngredient): number {
  if (name === "冰块") {
    return 60;
  }
  if (["柠檬", "青柠", "薄荷"].includes(name)) {
    return 10;
  }
  if (["糖浆", "蜂蜜"].includes(name)) {
    return 5;
  }
  return 80;
}

function hintForSpirit(spirit: DetectedIngredient): RecipeCandidate["safetyLevel"] {
  return spirit.abv === null ? "WARN" : "ALLOW";
}

function buildInitialCandidate(
  id: RecipeCandidate["id"],
  strategy: RecipeCandidate["strategy"],
  spirit: DetectedIngredient,
  supports: readonly DetectedIngredient[],
  missingIngredients: readonly UpgradeMissingIngredient[],
): RecipeCandidate {
  const spiritName = spirit.canonicalName;
  const supportMaterials = supports.map((support, index) =>
    material(
      support.canonicalName,
      support.category === "ice" ? (index === 0 ? 60 : 30) : index === 0 ? 90 : 15,
    ),
  );
  let materials: RecipeMaterial[];
  let steps: RecipeStep[];

  if (strategy === "A_CONSERVATIVE") {
    materials = [material(spiritName, 30), ...supportMaterials];
    steps = [
      {
        order: 1,
        instruction: "将已确认的白酒倒入杯中，加入桌面材料并轻轻搅拌。",
        isPhotoCheckpoint: true,
      },
      { order: 2, instruction: "静置 30 秒后小口试饮。", isPhotoCheckpoint: false },
    ];
  } else if (strategy === "B_CREATIVE") {
    materials = [
      material(spiritName, 35),
      ...supportMaterials.map((item) => ({ ...item, amountMl: Math.max(5, item.amountMl - 5) })),
    ];
    steps = [
      { order: 1, instruction: "先冷藏或用冰块降温桌面材料。", isPhotoCheckpoint: true },
      {
        order: 2,
        instruction: "沿杯壁分两次加入白酒，最后轻轻搅拌。",
        isPhotoCheckpoint: false,
      },
    ];
  } else {
    materials = [
      material(spiritName, 30),
      ...supportMaterials,
      ...missingIngredients.map((name) => material(name, missingMaterialAmount(name))),
    ];
    steps = [
      {
        order: 1,
        instruction: "先加入受控的升级材料，再加入桌面已有材料。",
        isPhotoCheckpoint: true,
      },
      {
        order: 2,
        instruction: "最后加入白酒，轻轻搅拌并试饮。",
        isPhotoCheckpoint: false,
      },
    ];
  }

  return {
    id,
    strategy,
    title:
      strategy === "A_CONSERVATIVE"
        ? "清爽稳妥白酒气泡饮"
        : strategy === "B_CREATIVE"
          ? "分层冷萃白酒调饮"
          : "柑橘升级白酒调饮",
    fitReason: "等待透明推荐排序",
    differenceReason:
      strategy === "A_CONSERVATIVE"
        ? "只使用已确认材料，以低认知负担和稳定比例为主。"
        : strategy === "B_CREATIVE"
          ? "通过比例、降温和分层加入顺序改变酒香与入口节奏。"
          : "在桌面材料基础上最多补充两种常见材料，增加香气或稀释路径。",
    materials,
    steps,
    estimatedAbv: estimateAbv(materials, spirit),
    safetyLevel: hintForSpirit(spirit),
    experimental: false,
    missingIngredients: [...missingIngredients],
  };
}

function findMaterialIndex(materials: readonly RecipeMaterial[], names: readonly string[]): number {
  return materials.findIndex((item) => names.includes(item.name));
}

function adjustExistingOrFallback(
  materials: RecipeMaterial[],
  names: readonly string[],
  fallbackIndex: number,
  delta: number,
): void {
  const existingIndex = findMaterialIndex(materials, names);
  adjustAmount(materials, existingIndex >= 0 ? existingIndex : fallbackIndex, delta);
}

function adjustAmount(materials: RecipeMaterial[], index: number, delta: number): void {
  if (index < 0) {
    return;
  }
  materials[index] = {
    ...materials[index],
    amountMl: Math.min(2000, Math.max(1, materials[index].amountMl + delta)),
  };
}

function addAdjustmentMaterial(
  materials: RecipeMaterial[],
  missingIngredients: UpgradeMissingIngredient[],
  confirmedMaterialNames: readonly string[],
  name: UpgradeMissingIngredient,
  amountMl: number,
): void {
  if (materials.some((item) => item.name === name)) {
    return;
  }
  const confirmedNames = new Set(confirmedMaterialNames);
  const addedMaterialNames = new Set(
    materials.map((item) => item.name).filter((materialName) => !confirmedNames.has(materialName)),
  );
  if (addedMaterialNames.size >= 2 || missingIngredients.length >= 2) {
    return;
  }
  materials.push(material(name, amountMl));
  missingIngredients.push(name);
}

export class FallbackRecipeProvider implements OutcomeAwareRecipeProvider {
  private readonly createId: () => RecipeCandidate["id"];

  constructor(options: FallbackRecipeProviderOptions = {}) {
    this.createId = options.createId ?? createRecipeId;
  }

  async generateWithOutcome(
    input: RecipeGenerationInput,
  ): Promise<RecipeProviderOutcome<RecipeCandidateSet>> {
    const parsed = RecipeGenerationInputSchema.parse(input);
    const { spirit, supports } = selectConfirmedIngredients(parsed);
    const combination = findCombination(supports);
    const missingIngredients = chooseMissingIngredients(supports, combination);
    const recipes = [
      buildInitialCandidate(this.createId(), "A_CONSERVATIVE", spirit, supports, []),
      buildInitialCandidate(this.createId(), "B_CREATIVE", spirit, supports, []),
      buildInitialCandidate(this.createId(), "C_UPGRADE", spirit, supports, missingIngredients),
    ];
    const allowedMaterialNames = parsed.ingredients
      .filter((ingredient) => ingredient.confirmed)
      .map((ingredient) => ingredient.canonicalName);
    const candidateSet = validateCandidateSet(
      {
        recipes,
        recommendedRecipeId: recipes[0].id,
      },
      { allowedMaterialNames },
    );

    return {
      value: rankRecommendation({
        preferences: parsed.preferences,
        candidateSet,
        allowedMaterialNames,
      }).candidateSet,
      sourceMode: "fallback",
      degraded: false,
    };
  }

  async generate(input: RecipeGenerationInput): Promise<RecipeCandidateSet> {
    return (await this.generateWithOutcome(input)).value;
  }

  async adjustWithOutcome(
    input: RecipeAdjustmentInput,
  ): Promise<RecipeProviderOutcome<RecipeCandidate>> {
    const parsed = RecipeAdjustmentInputSchema.parse(input);
    const constraints = parsed.constraints ?? buildAdjustmentConstraints(parsed.feedback);
    const adjustmentByDimension = new Map(
      constraints.constraints.map((constraint) => [constraint.dimension, constraint]),
    );
    const alcoholConstraint = adjustmentByDimension.get("alcoholIntensity");
    const bodyConstraint = adjustmentByDimension.get("body");
    const sweetnessConstraint = adjustmentByDimension.get("sweetness");
    const acidityConstraint = adjustmentByDimension.get("acidity");
    const materials = parsed.currentRecipe.materials.map((item) => ({ ...item }));
    const missingIngredients = [
      ...parsed.currentRecipe.missingIngredients,
    ] as UpgradeMissingIngredient[];
    const firstMaterial = materials[0];
    const spiritIndex =
      firstMaterial !== undefined && parsed.confirmedMaterialNames.includes(firstMaterial.name)
        ? 0
        : -1;
    const supportIndex = materials.findIndex(
      (item, index) => index !== spiritIndex && parsed.confirmedMaterialNames.includes(item.name),
    );
    const adjustmentFallbackIndex = supportIndex >= 0 ? supportIndex : spiritIndex;

    if (alcoholConstraint?.actions.includes("REDUCE_SPIRIT_VOLUME")) {
      adjustAmount(materials, spiritIndex, -5 * alcoholConstraint.magnitude);
    } else if (alcoholConstraint?.actions.includes("INCREASE_SPIRIT_VOLUME")) {
      adjustAmount(materials, spiritIndex, 5 * alcoholConstraint.magnitude);
    }
    if (alcoholConstraint?.actions.includes("INCREASE_DILUTION")) {
      if (parsed.currentRecipe.strategy === "C_UPGRADE") {
        addAdjustmentMaterial(
          materials,
          missingIngredients,
          parsed.confirmedMaterialNames,
          "冰块",
          20 * alcoholConstraint.magnitude,
        );
      } else {
        adjustAmount(materials, supportIndex, 20 * alcoholConstraint.magnitude);
      }
    }
    if (bodyConstraint?.actions.includes("REDUCE_BODY_SUPPORT")) {
      adjustAmount(materials, supportIndex, -10 * bodyConstraint.magnitude);
    } else if (bodyConstraint?.actions.includes("INCREASE_BODY_SUPPORT")) {
      adjustAmount(materials, supportIndex, 10 * bodyConstraint.magnitude);
    }

    if (sweetnessConstraint?.actions.includes("INCREASE_SWEETENER")) {
      if (parsed.currentRecipe.strategy === "C_UPGRADE") {
        const materialCount = materials.length;
        addAdjustmentMaterial(
          materials,
          missingIngredients,
          parsed.confirmedMaterialNames,
          "蜂蜜",
          5,
        );
        if (materials.length === materialCount) {
          adjustExistingOrFallback(
            materials,
            ["蜂蜜", "糖浆"],
            adjustmentFallbackIndex,
            5 * sweetnessConstraint.magnitude,
          );
        }
      } else {
        adjustExistingOrFallback(
          materials,
          ["蜂蜜", "糖浆"],
          adjustmentFallbackIndex,
          5 * sweetnessConstraint.magnitude,
        );
      }
    } else if (sweetnessConstraint?.actions.includes("REDUCE_SWEETENER")) {
      adjustExistingOrFallback(
        materials,
        ["蜂蜜", "糖浆"],
        adjustmentFallbackIndex,
        -5 * sweetnessConstraint.magnitude,
      );
    }

    if (acidityConstraint?.actions.includes("INCREASE_ACID_COMPONENT")) {
      if (parsed.currentRecipe.strategy === "C_UPGRADE") {
        const materialCount = materials.length;
        addAdjustmentMaterial(
          materials,
          missingIngredients,
          parsed.confirmedMaterialNames,
          "柠檬",
          10,
        );
        if (materials.length === materialCount) {
          adjustExistingOrFallback(
            materials,
            ["柠檬", "青柠", "果汁"],
            adjustmentFallbackIndex,
            5 * acidityConstraint.magnitude,
          );
        }
      } else {
        adjustExistingOrFallback(
          materials,
          ["柠檬", "青柠", "果汁"],
          adjustmentFallbackIndex,
          5 * acidityConstraint.magnitude,
        );
      }
    } else if (acidityConstraint?.actions.includes("REDUCE_ACID_COMPONENT")) {
      adjustExistingOrFallback(
        materials,
        ["柠檬", "青柠", "果汁"],
        adjustmentFallbackIndex,
        -5 * acidityConstraint.magnitude,
      );
    }

    if (
      bodyConstraint?.actions.includes("INCREASE_BODY_SUPPORT") &&
      parsed.currentRecipe.strategy === "C_UPGRADE"
    ) {
      const materialCount = materials.length;
      addAdjustmentMaterial(
        materials,
        missingIngredients,
        parsed.confirmedMaterialNames,
        "冰块",
        30,
      );
      if (materials.length === materialCount) {
        adjustExistingOrFallback(
          materials,
          ["冰块"],
          adjustmentFallbackIndex,
          10 * bodyConstraint.magnitude,
        );
      }
    }

    const adjusted = {
      ...parsed.currentRecipe,
      id: this.createId(),
      title: `${parsed.currentRecipe.title}·反馈调整`,
      fitReason: "根据本次反馈调整，最终安全结论由确定性 Safety 引擎裁决。",
      differenceReason: `根据反馈调整甜度 ${parsed.feedback.deltas.sweetness}、酸度 ${parsed.feedback.deltas.acidity}、酒感 ${parsed.feedback.deltas.alcoholIntensity}、厚重度 ${parsed.feedback.deltas.body}。`,
      materials,
      steps: [
        ...parsed.currentRecipe.steps,
        {
          order: parsed.currentRecipe.steps.length + 1,
          instruction: "完成调整后再次小口试饮并记录变化。",
          isPhotoCheckpoint: false,
        },
      ],
      missingIngredients,
    };

    return {
      value: validateAdjustedCandidate(
        adjusted,
        parsed.currentRecipe,
        parsed.confirmedMaterialNames,
      ),
      sourceMode: "fallback",
      degraded: false,
    };
  }

  async adjust(input: RecipeAdjustmentInput): Promise<RecipeCandidate> {
    return (await this.adjustWithOutcome(input)).value;
  }
}

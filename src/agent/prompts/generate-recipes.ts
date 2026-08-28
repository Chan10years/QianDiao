import type { RecipeAdjustmentInput, RecipeGenerationInput } from "@/src/providers/recipe-provider";

export const RECIPE_CANDIDATE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "strategy",
    "title",
    "fitReason",
    "differenceReason",
    "materials",
    "steps",
    "estimatedAbv",
    "safetyLevel",
    "experimental",
    "missingIngredients",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    strategy: { type: "string", enum: ["A_CONSERVATIVE", "B_CREATIVE", "C_UPGRADE"] },
    title: { type: "string", minLength: 1, maxLength: 500 },
    fitReason: { type: "string", minLength: 1, maxLength: 500 },
    differenceReason: { type: "string", minLength: 1, maxLength: 500 },
    materials: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "amountMl", "unit"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 100 },
          amountMl: { type: "number", exclusiveMinimum: 0, maximum: 2000 },
          unit: { const: "ml" },
        },
      },
    },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["order", "instruction", "isPhotoCheckpoint"],
        properties: {
          order: { type: "integer", minimum: 1 },
          instruction: { type: "string", minLength: 1, maxLength: 500 },
          isPhotoCheckpoint: { type: "boolean" },
        },
      },
    },
    estimatedAbv: { type: ["number", "null"], minimum: 0, maximum: 100 },
    safetyLevel: { type: "string", enum: ["ALLOW", "WARN", "BLOCK"] },
    experimental: { type: "boolean" },
    missingIngredients: {
      type: "array",
      maxItems: 2,
      items: { type: "string", minLength: 1, maxLength: 100 },
    },
  },
} as const;

export const RECIPE_CANDIDATE_SET_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["recipes", "recommendedRecipeId"],
  properties: {
    recipes: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: RECIPE_CANDIDATE_JSON_SCHEMA,
    },
    recommendedRecipeId: { type: "string", format: "uuid" },
  },
} as const;

const outputRules = [
  "只返回 JSON，不要 Markdown 代码围栏、解释或隐藏推理。",
  "generate 必须返回恰好三套：A_CONSERVATIVE、B_CREATIVE、C_UPGRADE 各一套，且三套 ID 不重复。",
  "A 只使用已确认桌面材料；B 以桌面材料为主，通过比例、顺序、温度或手法形成差异。",
  "C 最多增加两种材料，且只能从冰块、柠檬、青柠、苏打水、可乐、柠檬汽水、茶、果汁、糖浆、蜂蜜、薄荷中选择。",
  "differenceReason 必须说明三套为什么不是重复方案；无意义的 1 ml 微调不算差异。",
  "safetyLevel 只是模型提示，不能作为安全结论；最终 Safety 引擎裁决，具体规则由 Task 4/10 负责。",
  "请在至少一个适合观察状态变化的调制步骤上将 isPhotoCheckpoint 设为 true，其余步骤设为 false。",
].join("\n");

export function buildGenerateRecipesPrompt(input: RecipeGenerationInput): string {
  return [
    "你是白酒创意调饮方案生成器。",
    outputRules,
    "严格遵守以下 JSON Schema：",
    JSON.stringify(RECIPE_CANDIDATE_SET_JSON_SCHEMA),
    "已确认输入：",
    JSON.stringify(
      {
        preferences: input.preferences,
        ingredients: input.ingredients,
      },
      null,
      2,
    ),
  ].join("\n\n");
}

export function buildAdjustRecipePrompt(input: RecipeAdjustmentInput): string {
  return [
    "你是白酒创意调饮的单配方反馈调整器。",
    "只返回一个新的 RecipeCandidate JSON，不要返回 recipes 数组、候选集合、解释或隐藏推理。",
    "新候选必须保留当前配方的策略，使用新 UUID，并基于父配方上下文和本次反馈给出 differenceReason。",
    "safetyLevel 只是模型提示，不能作为安全结论；最终 Safety 引擎裁决，具体规则由 Task 4/10 负责。",
    "严格遵守以下 JSON Schema：",
    JSON.stringify(RECIPE_CANDIDATE_JSON_SCHEMA),
    "口味偏好：",
    JSON.stringify(input.preferences),
    "父配方上下文：",
    JSON.stringify(input.currentRecipe, null, 2),
    "本次反馈：",
    JSON.stringify(input.feedback, null, 2),
    "仅将以下实验记忆作为创意上下文，不得把它们当成安全结论：",
    JSON.stringify(input.experimentMemories ?? [], null, 2),
    "结构化调整约束：",
    JSON.stringify(input.constraints ?? null, null, 2),
  ].join("\n\n");
}

export function buildRepairPrompt(
  operation: "generate" | "adjust",
  invalidResponse: string,
): string {
  const schema =
    operation === "generate" ? RECIPE_CANDIDATE_SET_JSON_SCHEMA : RECIPE_CANDIDATE_JSON_SCHEMA;
  return [
    "上一次输出无法通过 JSON 解析或结构校验，请只修复格式和结构问题。",
    "不要增加解释，不要输出 Markdown 代码围栏，不要改变已要求的策略数量。",
    `当前操作：${operation === "generate" ? "generate 必须恰好 A/B/C 三套" : "adjust 必须只返回一个 RecipeCandidate"}`,
    "目标 JSON Schema：",
    JSON.stringify(schema),
    "待修复输出：",
    invalidResponse.slice(0, 8000),
  ].join("\n\n");
}

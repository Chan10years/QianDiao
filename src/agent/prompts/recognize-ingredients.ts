import type { VisionInput } from "@/src/providers/vision-provider";

export const VISION_RESULT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ingredients", "needsLabelCloseup", "userQuestions"],
  properties: {
    ingredients: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "rawName",
          "canonicalName",
          "category",
          "brand",
          "abv",
          "confidence",
          "confirmed",
        ],
        properties: {
          rawName: { type: "string", minLength: 1, maxLength: 100 },
          canonicalName: { type: "string", minLength: 1, maxLength: 100 },
          category: {
            type: "string",
            enum: [
              "spirit",
              "mixer",
              "tea",
              "fruit",
              "sweetener",
              "herb",
              "ice",
              "energy_drink",
              "medicine",
              "non_food",
              "unknown",
            ],
          },
          brand: { type: ["string", "null"], maxLength: 100 },
          abv: { type: ["number", "null"], minimum: 0, maximum: 100 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          confirmed: { const: false },
        },
      },
    },
    needsLabelCloseup: { type: "boolean" },
    userQuestions: {
      type: "array",
      maxItems: 5,
      items: { type: "string", minLength: 1, maxLength: 300 },
    },
  },
} as const;

const outputRules = [
  "只返回 JSON，不要 Markdown 代码围栏、解释或隐藏推理。",
  "rawName 保留照片中看到的名称；canonicalName 只能填写可识别的名称，不能编造品牌或酒精度。",
  "confidence 是识别置信度，不是用户确认；confirmed 必须为 false。",
  "酒类品牌或 ABV 不确定时，needsLabelCloseup 必须为 true，并提出简短用户问题。",
].join("\n");

export function buildRecognizeIngredientsPrompt(input: VisionInput): string {
  return [
    "你是白酒调饮材料识别器。",
    outputRules,
    "严格遵守以下 JSON Schema：",
    JSON.stringify(VISION_RESULT_JSON_SCHEMA),
    "总览图片资源 ID：",
    input.overviewImageId,
    "标签近照资源 ID：",
    JSON.stringify(input.labelImageIds),
  ].join("\n\n");
}

export function buildRepairVisionPrompt(invalidResponse: string): string {
  return [
    "上一次输出无法通过 JSON 解析或结构校验，请只修复格式和结构问题。",
    "不要增加解释，不要输出 Markdown 代码围栏或隐藏推理。",
    "目标 JSON Schema：",
    JSON.stringify(VISION_RESULT_JSON_SCHEMA),
    "待修复输出：",
    invalidResponse.slice(0, 8_000),
  ].join("\n\n");
}

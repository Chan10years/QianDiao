import { z } from "zod";

import {
  DetectedIngredientSchema,
  IngredientCategorySchema,
  type DetectedIngredient,
} from "@/src/domain/ingredient";

const MaterialAliasSchema = z.object({
  category: IngredientCategorySchema,
  canonicalName: z.string().trim().min(1),
  aliases: z.array(z.string().trim().min(1)).min(1),
});

const MATERIAL_ALIASES = [
  { category: "spirit", canonicalName: "白酒", aliases: ["白酒", "二锅头", "高粱酒", "baijiu"] },
  {
    category: "spirit",
    canonicalName: "伏特加",
    aliases: ["伏特加", "vodka"],
  },
  {
    category: "spirit",
    canonicalName: "威士忌",
    aliases: ["威士忌", "whisky", "whiskey"],
  },
  { category: "spirit", canonicalName: "白兰地", aliases: ["白兰地", "brandy"] },
  { category: "spirit", canonicalName: "朗姆酒", aliases: ["朗姆酒", "rum"] },
  { category: "spirit", canonicalName: "金酒", aliases: ["金酒", "gin"] },
  { category: "spirit", canonicalName: "啤酒", aliases: ["啤酒", "beer"] },
  { category: "spirit", canonicalName: "葡萄酒", aliases: ["葡萄酒", "红酒", "白葡萄酒", "wine"] },
  { category: "spirit", canonicalName: "清酒", aliases: ["清酒", "sake"] },
  { category: "mixer", canonicalName: "苏打水", aliases: ["苏打水", "气泡水", "soda water"] },
  { category: "mixer", canonicalName: "可乐", aliases: ["可乐", "可口可乐", "cola"] },
  { category: "mixer", canonicalName: "柠檬汽水", aliases: ["柠檬汽水", "雪碧", "sprite"] },
  { category: "mixer", canonicalName: "汤力水", aliases: ["汤力水", "tonic"] },
  { category: "mixer", canonicalName: "汽水", aliases: ["汽水", "soft drink"] },
  {
    category: "tea",
    canonicalName: "茶",
    aliases: ["茶", "红茶", "绿茶", "乌龙茶", "茉莉花茶", "tea"],
  },
  { category: "fruit", canonicalName: "柠檬", aliases: ["柠檬", "lemon"] },
  { category: "fruit", canonicalName: "青柠", aliases: ["青柠", " лайм", "lime"] },
  { category: "fruit", canonicalName: "橙子", aliases: ["橙子", "orange"] },
  {
    category: "fruit",
    canonicalName: "果汁",
    aliases: ["果汁", "橙汁", "苹果汁", "葡萄汁", "juice"],
  },
  { category: "fruit", canonicalName: "西柚", aliases: ["西柚", "葡萄柚", "grapefruit"] },
  { category: "sweetener", canonicalName: "糖浆", aliases: ["糖浆", "simple syrup", "syrup"] },
  { category: "sweetener", canonicalName: "蜂蜜", aliases: ["蜂蜜", "honey"] },
  { category: "sweetener", canonicalName: "白糖", aliases: ["白糖", "糖", "sugar"] },
  { category: "herb", canonicalName: "薄荷", aliases: ["薄荷", "mint"] },
  { category: "herb", canonicalName: "罗勒", aliases: ["罗勒", "basil"] },
  { category: "ice", canonicalName: "冰块", aliases: ["冰块", "冰", "ice"] },
  {
    category: "energy_drink",
    canonicalName: "能量饮料",
    aliases: ["能量饮料", "红牛", "monster", "energy drink"],
  },
  {
    category: "medicine",
    canonicalName: "药物",
    aliases: ["药", "药物", "感冒药", "止痛药", "medicine"],
  },
  {
    category: "non_food",
    canonicalName: "非食品材料",
    aliases: ["清洁剂", "洗洁精", "香水", "消毒液", "洗衣液", "cleaner"],
  },
] as const;

const ValidMaterialAliases = z.array(MaterialAliasSchema).parse(MATERIAL_ALIASES);
const AlcoholNamePattern =
  /酒|茅台|五粮液|郎酒|汾酒|洋河|古井贡|剑南春|泸州老窖|习酒|酒鬼酒|啤酒|白兰地|伏特加|威士忌|朗姆|金酒|葡萄酒|清酒|baijiu|vodka|whisky|whiskey|brandy|rum|gin|sake|beer|wine|tequila|mezcal|cognac|bourbon|liqueur|liquor|champagne|prosecco|cider|ale|lager|stout|pilsner|port|sherry|vermouth|absinthe|amaro|aperitif|digestif|hard\s+seltzer/iu;

export const VisionInputSchema = z
  .object({
    overviewImageId: z.string().uuid(),
    labelImageIds: z.array(z.string().uuid()).max(5),
  })
  .strict();

export const VisionSourceModeSchema = z.enum(["fallback", "qwen"]);

export const VisionResultSchema = z
  .object({
    ingredients: z.array(DetectedIngredientSchema).min(1).max(50),
    needsLabelCloseup: z.boolean(),
    userQuestions: z.array(z.string().trim().min(1).max(300)).max(5),
    sourceMode: VisionSourceModeSchema.default("qwen"),
  })
  .strict();

export type VisionInput = z.infer<typeof VisionInputSchema>;
export type VisionResult = z.infer<typeof VisionResultSchema>;
export type VisionSourceMode = z.infer<typeof VisionSourceModeSchema>;

export interface VisionProvider {
  recognize(input: VisionInput): Promise<VisionResult>;
}

export interface VisionImageContent {
  imageId: string;
  mime: "image/jpeg";
  dataUrl: string;
}

export interface VisionImageLoader {
  load(input: VisionInput): Promise<readonly VisionImageContent[]>;
}

export interface QwenVisionCompletionRequest {
  model: string;
  prompt: string;
  timeoutMs: number;
  jsonSchema: unknown;
  images: readonly VisionImageContent[];
}

export interface QwenVisionCompletionClient {
  complete(request: QwenVisionCompletionRequest): Promise<string>;
}

function materialText(ingredient: Pick<DetectedIngredient, "rawName" | "canonicalName">): string {
  return `${ingredient.rawName} ${ingredient.canonicalName}`.trim().toLocaleLowerCase();
}

function findMaterialAlias(ingredient: Pick<DetectedIngredient, "rawName" | "canonicalName">) {
  const text = materialText(ingredient);
  return ValidMaterialAliases.find((entry) =>
    entry.aliases.some((alias) => text.includes(alias.toLocaleLowerCase())),
  );
}

export function isAlcoholIngredient(
  ingredient: Pick<DetectedIngredient, "rawName" | "canonicalName" | "category"> &
    Partial<Pick<DetectedIngredient, "brand">>,
): boolean {
  const text = `${materialText(ingredient)} ${ingredient.brand ?? ""}`.trim();
  return ingredient.category === "spirit" || AlcoholNamePattern.test(text);
}

export function needsLabelCloseupForIngredient(ingredient: DetectedIngredient): boolean {
  return (
    isAlcoholIngredient(ingredient) &&
    (ingredient.category !== "spirit" || ingredient.confidence < 0.8 || ingredient.abv === null)
  );
}

export function normalizeIngredient(input: DetectedIngredient): DetectedIngredient {
  const parsed = DetectedIngredientSchema.parse(input);
  const alias = findMaterialAlias(parsed);
  const canonicalName =
    alias?.canonicalName ?? (parsed.canonicalName.trim() || parsed.rawName.trim());
  const category = alias?.category ?? (parsed.category === "spirit" ? "spirit" : "unknown");

  return DetectedIngredientSchema.parse({
    ...parsed,
    rawName: parsed.rawName.trim(),
    canonicalName,
    category,
    confirmed: false,
  });
}

export function normalizeVisionResult(input: VisionResult): VisionResult {
  const parsed = VisionResultSchema.parse(input);
  const byCanonicalName = new Map<string, DetectedIngredient>();

  for (const ingredient of parsed.ingredients.map(normalizeIngredient)) {
    const previous = byCanonicalName.get(ingredient.canonicalName);
    if (previous === undefined || ingredient.confidence > previous.confidence) {
      byCanonicalName.set(ingredient.canonicalName, ingredient);
    }
  }

  const ingredients = [...byCanonicalName.values()];
  const needsLabelCloseup =
    parsed.needsLabelCloseup || ingredients.some(needsLabelCloseupForIngredient);
  const questions = new Set(parsed.userQuestions);
  const labelCloseupQuestion = "请补拍酒类瓶身标签近照，并确认品牌与酒精度（ABV）。";
  if (needsLabelCloseup) {
    questions.add(labelCloseupQuestion);
  }

  const userQuestions = needsLabelCloseup
    ? [
        labelCloseupQuestion,
        ...[...questions].filter((question) => question !== labelCloseupQuestion),
      ].slice(0, 5)
    : [...questions].slice(0, 5);

  return VisionResultSchema.parse({
    ingredients,
    needsLabelCloseup,
    userQuestions,
    sourceMode: parsed.sourceMode,
  });
}

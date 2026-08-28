export const UPGRADE_MISSING_INGREDIENTS = [
  "冰块",
  "柠檬",
  "青柠",
  "苏打水",
  "可乐",
  "柠檬汽水",
  "茶",
  "果汁",
  "糖浆",
  "蜂蜜",
  "薄荷",
] as const;

export type UpgradeMissingIngredient = (typeof UPGRADE_MISSING_INGREDIENTS)[number];

export interface FallbackCombination {
  readonly id: "water-ice" | "soda" | "tea" | "juice";
  readonly names: readonly string[];
  readonly defaultMissing: readonly UpgradeMissingIngredient[];
}

export const FALLBACK_COMBINATIONS: readonly FallbackCombination[] = [
  {
    id: "water-ice",
    names: ["水", "冰块"],
    defaultMissing: ["冰块"],
  },
  {
    id: "soda",
    names: ["苏打水", "可乐", "柠檬汽水"],
    defaultMissing: ["苏打水"],
  },
  {
    id: "tea",
    names: ["茶", "红茶", "绿茶", "乌龙茶"],
    defaultMissing: ["茶"],
  },
  {
    id: "juice",
    names: ["果汁", "橙汁", "苹果汁", "葡萄汁"],
    defaultMissing: ["果汁"],
  },
];

export function isUpgradeMissingIngredient(value: string): value is UpgradeMissingIngredient {
  return (UPGRADE_MISSING_INGREDIENTS as readonly string[]).includes(value);
}

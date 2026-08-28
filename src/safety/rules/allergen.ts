import type { SafetyRule } from "@/src/safety/types";

const knownAllergenNames = new Set(["花生", "坚果", "牛奶", "乳制品", "鸡蛋", "大豆", "小麦"]);

export const allergenRule: SafetyRule = {
  ruleId: "SAFETY_ALLERGEN",
  ruleVersion: 1,
  version: 1,
  title: "Known allergen",
  severity: "WARN",
  conditions: [
    { id: "allergen-flag", description: "An ingredient is explicitly marked as an allergen." },
  ],
  reason:
    "This recipe contains a known or user-marked allergen and requires explicit confirmation.",
  alternative: "Remove the allergen or replace it with a confirmed safe ingredient.",
  evidence: [
    {
      source: "FDA: Food Allergies",
      url: "https://www.fda.gov/food/food-labeling-nutrition/food-allergies",
      note: "Food allergens can cause serious reactions and require clear identification.",
    },
  ],
  matches: (input) =>
    input.ingredients.some(
      (ingredient) =>
        ingredient.allergen === true ||
        knownAllergenNames.has(ingredient.canonicalName ?? ingredient.name),
    ),
};

export default allergenRule;

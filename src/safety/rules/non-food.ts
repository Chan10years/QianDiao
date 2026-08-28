import type { SafetyRule } from "@/src/safety/types";

export const nonFoodRule: SafetyRule = {
  ruleId: "SAFETY_NON_FOOD_OR_CHEMICAL",
  ruleVersion: 1,
  version: 1,
  title: "Medicine, non-food, or unknown chemical",
  severity: "BLOCK",
  conditions: [
    {
      id: "unsafe-category-present",
      description: "A material is classified as medicine, non-food, or unknown.",
    },
  ],
  reason: "Medicine, non-food materials, and unknown chemicals must not be used in a drink.",
  alternative: "Remove the material and use only confirmed food-grade ingredients.",
  evidence: [
    {
      source: "FDA: Food Ingredients and Packaging",
      url: "https://www.fda.gov/food/food-ingredients-packaging",
      note: "Only suitable food-grade ingredients belong in a drink.",
    },
  ],
  matches: (input) =>
    input.ingredients.some((ingredient) =>
      ["medicine", "non_food", "unknown"].includes(ingredient.category),
    ),
};

export default nonFoodRule;

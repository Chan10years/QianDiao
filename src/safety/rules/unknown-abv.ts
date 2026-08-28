import type { SafetyRule } from "@/src/safety/types";

function hasUnconfirmedAbv(ingredient: {
  category: string;
  abv: number | null;
  confirmed?: boolean;
}) {
  return (
    ingredient.category === "spirit" &&
    (ingredient.confirmed !== true ||
      ingredient.abv === null ||
      !Number.isFinite(ingredient.abv) ||
      ingredient.abv < 0 ||
      ingredient.abv > 100)
  );
}

export const unknownAbvRule: SafetyRule = {
  ruleId: "SAFETY_UNKNOWN_ABV",
  ruleVersion: 1,
  version: 1,
  title: "Unconfirmed spirit ABV",
  severity: "BLOCK",
  conditions: [
    {
      id: "spirit-abv-confirmed",
      description: "Every spirit has a finite ABV from 0 through 100 and has been confirmed.",
    },
  ],
  reason: "A spirit cannot be used until its ABV is known and confirmed.",
  alternative: "Read the bottle label, enter the ABV, and confirm it before generating a recipe.",
  evidence: [
    {
      source: "NIAAA: Alcohol Facts and Statistics",
      url: "https://www.niaaa.nih.gov/alcohols-effects-health/alcohol-topics/alcohol-facts-and-statistics",
      note: "Alcohol amount depends on the beverage's alcohol concentration and serving size.",
    },
  ],
  matches: (input) => input.ingredients.some(hasUnconfirmedAbv),
};

export default unknownAbvRule;

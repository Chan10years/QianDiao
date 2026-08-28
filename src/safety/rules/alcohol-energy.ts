import type { SafetyRule } from "@/src/safety/types";

const evidence = [
  {
    source: "CDC: Alcohol and Caffeine",
    url: "https://www.cdc.gov/alcohol/about-alcohol-use/alcohol-and-caffeine.html",
    note: "Alcohol and caffeinated energy drinks can mask perceived intoxication and increase risk-taking.",
  },
] as const;

export const alcoholEnergyRule: SafetyRule = {
  ruleId: "SAFETY_ALCOHOL_ENERGY",
  ruleVersion: 1,
  version: 1,
  title: "Alcohol with an energy drink",
  severity: "BLOCK",
  conditions: [
    { id: "alcohol-present", description: "At least one alcoholic ingredient is present." },
    { id: "energy-drink-present", description: "At least one energy drink is present." },
  ],
  reason: "Alcohol and energy drinks are not allowed in the same recipe.",
  alternative: "Remove the energy drink and use water, soda water, tea, or juice instead.",
  evidence,
  matches: (input) => {
    const hasAlcohol = input.ingredients.some(
      (ingredient) =>
        ingredient.volumeMl > 0 &&
        (ingredient.category === "spirit" || (ingredient.abv !== null && ingredient.abv > 0)),
    );
    const hasEnergyDrink = input.ingredients.some(
      (ingredient) => ingredient.category === "energy_drink" && ingredient.volumeMl > 0,
    );

    return hasAlcohol && hasEnergyDrink;
  },
};

export default alcoholEnergyRule;

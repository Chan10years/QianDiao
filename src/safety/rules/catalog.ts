import type { SafetyRule } from "@/src/safety/types";
import { alcoholEnergyRule } from "@/src/safety/rules/alcohol-energy";
import { allergenRule } from "@/src/safety/rules/allergen";
import { experimentalRule } from "@/src/safety/rules/experimental";
import { nonFoodRule } from "@/src/safety/rules/non-food";
import { unknownAbvRule } from "@/src/safety/rules/unknown-abv";

export const SAFETY_RULES: readonly SafetyRule[] = Object.freeze([
  alcoholEnergyRule,
  nonFoodRule,
  unknownAbvRule,
  allergenRule,
  experimentalRule,
]);

export const SAFETY_RULE_CATALOG = SAFETY_RULES;

export function getSafetyRules(): readonly SafetyRule[] {
  return SAFETY_RULES;
}

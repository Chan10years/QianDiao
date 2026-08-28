import { calculateAlcohol } from "@/src/safety/calculate-alcohol";
import { SAFETY_RULES } from "@/src/safety/rules/catalog";
import type { SafetyDecision, SafetyHit, SafetyInput, SafetyLevel } from "@/src/safety/types";

const severityRank: Record<SafetyLevel, number> = {
  ALLOW: 0,
  WARN: 1,
  BLOCK: 2,
};

function totalDrinkMl(input: SafetyInput): number {
  if (input.totalDrinkMl !== undefined) {
    return input.totalDrinkMl;
  }

  return input.ingredients.reduce((total, ingredient) => total + ingredient.volumeMl, 0);
}

function toSafetyHit(rule: (typeof SAFETY_RULES)[number]): SafetyHit {
  return {
    ruleId: rule.ruleId,
    ruleVersion: rule.ruleVersion,
    level: rule.severity,
    reason: rule.reason,
    ...(rule.alternative === undefined ? {} : { alternative: rule.alternative }),
  };
}

export function evaluateSafety(input: SafetyInput): SafetyDecision {
  const drinkVolumeMl = totalDrinkMl(input);
  const alcoholCalculation = calculateAlcohol({
    portions: input.ingredients
      .filter(
        (ingredient) =>
          ingredient.category === "spirit" || (ingredient.abv !== null && ingredient.abv > 0),
      )
      .map((ingredient) => ({
        volumeMl: ingredient.volumeMl,
        abv: ingredient.confirmed === true ? ingredient.abv : null,
      })),
    totalDrinkMl: drinkVolumeMl,
  });

  const hits = SAFETY_RULES.filter((rule) => rule.matches(input))
    .map(toSafetyHit)
    .sort(
      (left, right) =>
        severityRank[right.level] - severityRank[left.level] ||
        left.ruleId.localeCompare(right.ruleId),
    );

  const level = hits.reduce<SafetyLevel>(
    (current, hit) => (severityRank[hit.level] > severityRank[current] ? hit.level : current),
    "ALLOW",
  );

  return {
    level,
    estimatedFinalAbv: alcoholCalculation.finalAbv,
    pureAlcoholMl: alcoholCalculation.pureAlcoholMl,
    hits,
  };
}

export default evaluateSafety;

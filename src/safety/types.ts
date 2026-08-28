import type { IngredientCategory } from "@/src/domain/ingredient";
import type { SafetyLevel as DomainSafetyLevel } from "@/src/domain/safety";

export type SafetyLevel = DomainSafetyLevel;

export interface EvidenceRef {
  source: string;
  url: string;
  note?: string;
}

export interface SafetyIngredient {
  name: string;
  category: IngredientCategory;
  volumeMl: number;
  abv: number | null;
  confirmed?: boolean;
  allergen?: boolean;
  experimental?: boolean;
  canonicalName?: string;
}

export interface SafetyInput {
  ingredients: readonly SafetyIngredient[];
  totalDrinkMl?: number;
  experimental?: boolean;
  /** Provider/candidate hint only. It is intentionally ignored by the engine. */
  safetyLevel?: SafetyLevel;
}

export interface SafetyHit {
  ruleId: string;
  ruleVersion: number;
  level: SafetyLevel;
  reason: string;
  alternative?: string;
}

export interface SafetyDecision {
  level: SafetyLevel;
  estimatedFinalAbv: number | null;
  pureAlcoholMl: number | null;
  hits: SafetyHit[];
}

export interface RuleCondition {
  id: string;
  description: string;
}

export interface SafetyRule {
  ruleId: string;
  /** Stable persisted rule version used by decision events. */
  ruleVersion: number;
  /** Alias retained for the architecture specification's rule shape. */
  version: number;
  title: string;
  severity: SafetyLevel;
  conditions: readonly RuleCondition[];
  reason: string;
  evidence: readonly EvidenceRef[];
  alternative?: string;
  matches: (input: SafetyInput) => boolean;
}

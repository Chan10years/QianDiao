import {
  RecipeCandidateSchema,
  RecipeCandidateSetSchema,
  type RecipeCandidate,
  type RecipeCandidateSet,
} from "@/src/domain/recipe";
import { isUpgradeMissingIngredient } from "@/src/agent/fallback/catalog";

export type CandidateSetValidationCode =
  | "INVALID_SCHEMA"
  | "INVALID_MISSING_INGREDIENTS"
  | "INVALID_CANDIDATE_CONSTRAINT"
  | "DUPLICATE_CANDIDATE";

export class CandidateSetValidationError extends Error {
  readonly code: CandidateSetValidationCode;

  constructor(code: CandidateSetValidationCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "CandidateSetValidationError";
    this.code = code;
  }
}

function normalizedStepSignature(candidate: RecipeCandidate): string {
  return candidate.steps
    .slice()
    .sort((left, right) => left.order - right.order)
    .map((step) =>
      step.instruction
        .trim()
        .toLocaleLowerCase()
        .replace(/[\s，。、“”‘’'",.!！？?、:：;；]+/gu, ""),
    )
    .join("|");
}

function sameMaterialsWithinOneMl(left: RecipeCandidate, right: RecipeCandidate): boolean {
  const leftMaterials = [...left.materials].sort((a, b) => a.name.localeCompare(b.name));
  const rightMaterials = [...right.materials].sort((a, b) => a.name.localeCompare(b.name));

  if (leftMaterials.length !== rightMaterials.length) {
    return false;
  }

  return leftMaterials.every((material, index) => {
    const other = rightMaterials[index];
    return material.name === other.name && Math.abs(material.amountMl - other.amountMl) <= 1;
  });
}

function hasMeaningfulDifference(left: RecipeCandidate, right: RecipeCandidate): boolean {
  return !(
    sameMaterialsWithinOneMl(left, right) &&
    normalizedStepSignature(left) === normalizedStepSignature(right)
  );
}

function validateMissingIngredients(candidate: RecipeCandidate): void {
  const missing = candidate.missingIngredients;

  if (missing.length > 2 || new Set(missing).size !== missing.length) {
    throw new CandidateSetValidationError(
      "INVALID_MISSING_INGREDIENTS",
      `${candidate.strategy} may contain at most two distinct missing ingredients`,
    );
  }

  if (candidate.strategy !== "C_UPGRADE" && missing.length > 0) {
    throw new CandidateSetValidationError(
      "INVALID_MISSING_INGREDIENTS",
      `${candidate.strategy} cannot request missing ingredients`,
    );
  }

  if (
    candidate.strategy === "C_UPGRADE" &&
    missing.some((name) => !isUpgradeMissingIngredient(name))
  ) {
    throw new CandidateSetValidationError(
      "INVALID_MISSING_INGREDIENTS",
      "C_UPGRADE missing ingredients must come from the frozen allowlist",
    );
  }
}

function uniqueMaterialNames(candidate: RecipeCandidate): string[] {
  return [...new Set(candidate.materials.map((material) => material.name))];
}

function validateCandidateMaterials(
  candidate: RecipeCandidate,
  confirmedMaterialNames: readonly string[],
): void {
  const confirmedNames = new Set(confirmedMaterialNames);
  const materialNames = uniqueMaterialNames(candidate);
  const addedNames = materialNames.filter((name) => !confirmedNames.has(name));

  if (candidate.strategy !== "C_UPGRADE") {
    const uncontrolledMaterial = addedNames[0];
    if (uncontrolledMaterial) {
      throw new CandidateSetValidationError(
        "INVALID_CANDIDATE_CONSTRAINT",
        `${candidate.strategy} materials must use confirmed material names; received ${uncontrolledMaterial}`,
      );
    }
    return;
  }

  const uncontrolledMaterial = addedNames.find((name) => !isUpgradeMissingIngredient(name));
  if (uncontrolledMaterial) {
    throw new CandidateSetValidationError(
      "INVALID_CANDIDATE_CONSTRAINT",
      `C_UPGRADE materials must use confirmed or frozen allowlist ingredients; received ${uncontrolledMaterial}`,
    );
  }

  if (addedNames.length > 2) {
    throw new CandidateSetValidationError(
      "INVALID_CANDIDATE_CONSTRAINT",
      "C_UPGRADE may add at most two distinct materials beyond confirmed materials",
    );
  }
}

export function validateAdjustedCandidate(
  input: unknown,
  currentRecipe: RecipeCandidate,
  confirmedMaterialNames: readonly string[],
): RecipeCandidate {
  const parsed = RecipeCandidateSchema.safeParse(input);
  if (!parsed.success) {
    throw new CandidateSetValidationError("INVALID_SCHEMA", parsed.error.message);
  }

  if (parsed.data.strategy !== currentRecipe.strategy) {
    throw new CandidateSetValidationError(
      "INVALID_CANDIDATE_CONSTRAINT",
      `adjusted candidate must keep ${currentRecipe.strategy} strategy`,
    );
  }

  validateMissingIngredients(parsed.data);
  validateCandidateMaterials(parsed.data, confirmedMaterialNames);
  return parsed.data;
}

export interface CandidateSetValidationOptions {
  readonly allowedMaterialNames?: readonly string[];
}

export function validateCandidateSet(
  input: unknown,
  options: CandidateSetValidationOptions = {},
): RecipeCandidateSet {
  const parsed = RecipeCandidateSetSchema.safeParse(input);
  if (!parsed.success) {
    throw new CandidateSetValidationError("INVALID_SCHEMA", parsed.error.message);
  }

  const fallbackMaterialNames = parsed.data.recipes
    .filter((candidate) => candidate.strategy !== "C_UPGRADE")
    .flatMap((candidate) => candidate.materials)
    .map((material) => material.name);
  const confirmedMaterialNames = options.allowedMaterialNames ?? fallbackMaterialNames;

  for (const candidate of parsed.data.recipes) {
    validateMissingIngredients(candidate);
    validateCandidateMaterials(candidate, confirmedMaterialNames);
  }

  for (let leftIndex = 0; leftIndex < parsed.data.recipes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < parsed.data.recipes.length; rightIndex += 1) {
      const left = parsed.data.recipes[leftIndex];
      const right = parsed.data.recipes[rightIndex];
      if (!hasMeaningfulDifference(left, right)) {
        throw new CandidateSetValidationError(
          "DUPLICATE_CANDIDATE",
          `${left.strategy} and ${right.strategy} have no meaningful material or step difference`,
        );
      }
    }
  }

  return parsed.data;
}

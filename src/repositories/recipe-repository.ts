import type { RecipeCandidate, RecipeMaterial, RecipeStep } from "@/src/domain/recipe";
import type { SafetyLevel } from "@/src/domain/safety";

export type RecipeSourceMode = "fallback" | "qwen";

export class RecipeDataIntegrityError extends Error {
  readonly code = "RECIPE_DATA_INTEGRITY";

  constructor() {
    super("RECIPE_DATA_INTEGRITY");
    this.name = "RecipeDataIntegrityError";
  }
}

export interface RecipeWriteInput {
  candidate: unknown;
  version?: number;
  parentRecipeId?: string | null;
  feedbackId?: string | null;
}

export interface SafetyRuleHitRecord {
  ruleId: string;
  ruleVersion: number;
  level: SafetyLevel;
  reason: string;
  alternative?: string;
}

export interface SafetyDecisionWriteInput {
  recipeId: string;
  level: SafetyLevel;
  ruleHits: readonly SafetyRuleHitRecord[];
  engineVersion: string;
}

export interface DecisionEventWriteInput {
  type: string;
  summary: string;
  metadata: Record<string, unknown>;
}

export interface CreateRecipeSetInput {
  id: string;
  sessionId: string;
  sourceMode: RecipeSourceMode;
}

export interface CreateRecipeInput {
  recipeSetId: string;
  sessionId: string;
  candidate: unknown;
  version?: number;
  parentRecipeId?: string | null;
  feedbackId?: string | null;
}

export interface CreateSingleRecipeSetInput {
  recipeSet: CreateRecipeSetInput;
  recipe: CreateRecipeInput & {
    candidate: RecipeCandidate;
    version: number;
    parentRecipeId: string;
    feedbackId: string;
  };
}

export interface CreateRecipeBatchInput {
  sessionId: string;
  requestId: string;
  expectedVersion: number;
  recipeSetId: string;
  sourceMode: RecipeSourceMode;
  recipes: readonly RecipeWriteInput[];
  recommendedRecipeId: string;
  safetyDecisions: readonly SafetyDecisionWriteInput[];
  event: DecisionEventWriteInput;
}

export interface RecipeSetRecord {
  id: string;
  sessionId: string;
  recommendedRecipeId: string | null;
  sourceMode: RecipeSourceMode;
  createdAt: Date;
}

export interface RecipeRecord {
  id: string;
  sessionId: string;
  recipeSetId: string;
  strategy: RecipeCandidate["strategy"];
  title: string;
  fitReason: string;
  differenceReason: string;
  materials: RecipeMaterial[];
  steps: RecipeStep[];
  estimatedAbv: number | null;
  safetyLevel: SafetyLevel;
  experimental: boolean;
  missingIngredients: string[];
  version: number;
  parentRecipeId: string | null;
  feedbackId: string | null;
  createdAt: Date;
}

export interface SafetyDecisionRecord {
  id: string;
  recipeId: string;
  level: SafetyLevel;
  ruleHits: SafetyRuleHitRecord[];
  engineVersion: string;
  createdAt: Date;
}

export interface DecisionEventRecord {
  id: string;
  sessionId: string;
  type: string;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface ExperimentMemoryRecord {
  id: string;
  recipeId: string;
  feedbackId: string;
  summary: string;
  tags: string[];
  createdAt: Date;
}

export interface CreateExperimentMemoryInput {
  id: string;
  recipeId: string;
  feedbackId: string;
  summary: string;
  tags: readonly string[];
}

export interface RecipeRepository {
  createRecipeSet(input: CreateRecipeSetInput): string;
  createSingleRecipeSet(input: CreateSingleRecipeSetInput): RecipeRecord;
  setRecommendedRecipe(recipeSetId: string, recipeId: string): void;
  createRecipe(input: CreateRecipeInput): RecipeRecord;
  createSafetyDecision(input: SafetyDecisionWriteInput): void;
  createBatch(input: CreateRecipeBatchInput): RecipeSetRecord;
  findById(id: string): RecipeRecord | null;
  findSetById(id: string): RecipeSetRecord | null;
  findSetBySession(sessionId: string): RecipeSetRecord | null;
  listBySession(sessionId: string): RecipeRecord[];
  findInitialRecipeSetBySession(sessionId: string): RecipeRecord[];
  findCurrentRecipeBySession(sessionId: string): RecipeRecord | null;
  listRecipeVersionChain(recipeId: string): RecipeRecord[];
  listBySet(recipeSetId: string): RecipeRecord[];
  listSafetyDecisionsBySet(recipeSetId: string): SafetyDecisionRecord[];
  listDecisionEvents(sessionId: string): DecisionEventRecord[];
  createExperimentMemory(input: CreateExperimentMemoryInput): ExperimentMemoryRecord;
  listExperimentMemories(recipeId: string): ExperimentMemoryRecord[];
}

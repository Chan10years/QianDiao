import { randomUUID } from "node:crypto";

import { asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import {
  RecipeCandidateSchema,
  RecipeCandidateSetSchema,
  RecipeMaterialSchema,
  RecipeStepSchema,
  RecipeStrategySchema,
} from "@/src/domain/recipe";
import { SafetyLevelSchema } from "@/src/domain/safety";
import type { RecipeCandidate } from "@/src/domain/recipe";
import type { SafetyLevel } from "@/src/domain/safety";
import type { DatabaseExecutor } from "@/src/infrastructure/db/transaction";
import {
  decisionEvents,
  experimentMemories,
  feedback,
  recipeSets,
  recipes,
  safetyDecisions,
  sessions,
} from "@/src/infrastructure/db/schema";
import { DrizzleSessionRepository } from "@/src/infrastructure/repositories/drizzle-session-repository";
import {
  SessionMutationInProgressError,
  SessionVersionConflictError,
} from "@/src/repositories/session-repository";
import { RecipeDataIntegrityError } from "@/src/repositories/recipe-repository";
import type {
  CreateExperimentMemoryInput,
  CreateRecipeBatchInput,
  CreateRecipeInput,
  CreateSingleRecipeSetInput,
  CreateRecipeSetInput,
  DecisionEventRecord,
  ExperimentMemoryRecord,
  RecipeRecord,
  RecipeRepository,
  RecipeSetRecord,
  SafetyDecisionRecord,
  SafetyDecisionWriteInput,
} from "@/src/repositories/recipe-repository";

const RecipeMaterialsSchema = z.array(RecipeMaterialSchema).min(1).max(20);
const RecipeStepsSchema = z.array(RecipeStepSchema).min(1).max(20);
const MissingIngredientsSchema = z.array(z.string().trim().min(1).max(100)).max(2);
const SourceModeSchema = z.enum(["fallback", "qwen"]);
const MetadataSchema = z.record(z.string(), z.unknown());
const TagsSchema = z.array(z.string().trim().min(1).max(100)).max(50);
const FeedbackIdSchema = z.string().uuid().nullable();
const SafetyRuleHitSchema = z
  .object({
    ruleId: z.string().trim().min(1).max(100),
    ruleVersion: z.number().int().positive(),
    level: SafetyLevelSchema,
    reason: z.string().trim().min(1).max(1000),
    alternative: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();
const SafetyRuleHitsSchema = z.array(SafetyRuleHitSchema).max(100);
const SafetyDecisionWriteSchema = z
  .object({
    recipeId: z.string().uuid(),
    level: SafetyLevelSchema,
    ruleHits: SafetyRuleHitsSchema,
    engineVersion: z.string().trim().min(1).max(100),
  })
  .strict();
const DecisionEventWriteSchema = z
  .object({
    type: z.string().trim().min(1).max(100),
    summary: z.string().trim().min(1).max(1000),
    metadata: MetadataSchema,
  })
  .strict();
const CreateRecipeVersionSchema = z.object({
  version: z.number().int().positive(),
  parentRecipeId: z.string().uuid().nullable(),
});
const CreateSingleRecipeVersionSchema = z.object({
  version: z.number().int().min(2),
  parentRecipeId: z.string().uuid(),
  feedbackId: z.string().uuid(),
});

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function toRecipeSetRecord(row: typeof recipeSets.$inferSelect): RecipeSetRecord {
  try {
    return {
      id: row.id,
      sessionId: row.sessionId,
      recommendedRecipeId: row.recommendedRecipeId,
      sourceMode: SourceModeSchema.parse(row.sourceMode),
      createdAt: row.createdAt,
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new RecipeDataIntegrityError();
    }
    throw error;
  }
}

function toRecipeRecord(row: typeof recipes.$inferSelect): RecipeRecord {
  try {
    return {
      id: row.id,
      sessionId: row.sessionId,
      recipeSetId: row.recipeSetId,
      strategy: RecipeStrategySchema.parse(row.strategy),
      title: row.title,
      fitReason: row.fitReason,
      differenceReason: row.differenceReason,
      materials: RecipeMaterialsSchema.parse(parseJson(row.materialsJson)),
      steps: RecipeStepsSchema.parse(parseJson(row.stepsJson)),
      estimatedAbv: row.estimatedAbv,
      safetyLevel: SafetyLevelSchema.parse(row.safetyLevel),
      experimental: row.experimental,
      missingIngredients: MissingIngredientsSchema.parse(parseJson(row.missingIngredientsJson)),
      version: row.version,
      parentRecipeId: row.parentRecipeId,
      feedbackId: FeedbackIdSchema.parse(row.feedbackId),
      createdAt: row.createdAt,
    };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new RecipeDataIntegrityError();
    }
    throw error;
  }
}

function toSafetyDecisionRecord(row: typeof safetyDecisions.$inferSelect): SafetyDecisionRecord {
  try {
    return {
      id: row.id,
      recipeId: row.recipeId,
      level: SafetyLevelSchema.parse(row.level),
      ruleHits: SafetyRuleHitsSchema.parse(parseJson(row.ruleHitsJson)),
      engineVersion: row.engineVersion,
      createdAt: row.createdAt,
    };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new RecipeDataIntegrityError();
    }
    throw error;
  }
}

function toDecisionEventRecord(row: typeof decisionEvents.$inferSelect): DecisionEventRecord {
  try {
    return {
      id: row.id,
      sessionId: row.sessionId,
      type: row.eventType,
      summary: row.summary,
      metadata: MetadataSchema.parse(parseJson(row.metadataJson)),
      createdAt: row.createdAt,
    };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      throw new RecipeDataIntegrityError();
    }
    throw error;
  }
}

function toExperimentMemoryRecord(
  row: typeof experimentMemories.$inferSelect,
): ExperimentMemoryRecord {
  return {
    id: row.id,
    recipeId: row.recipeId,
    feedbackId: row.feedbackId,
    summary: row.summary,
    tags: TagsSchema.parse(parseJson(row.tagsJson)),
    createdAt: row.createdAt,
  };
}

export class DrizzleRecipeRepository implements RecipeRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  createRecipeSet(input: CreateRecipeSetInput): string {
    const sourceMode = SourceModeSchema.parse(input.sourceMode);
    this.database
      .insert(recipeSets)
      .values({
        id: input.id,
        sessionId: input.sessionId,
        sourceMode,
        recommendedRecipeId: null,
      })
      .run();
    return input.id;
  }

  createRecipe(input: CreateRecipeInput): RecipeRecord {
    const candidate = RecipeCandidateSchema.parse(input.candidate);
    const versionInput = CreateRecipeVersionSchema.parse({
      version: input.version ?? 1,
      parentRecipeId: input.parentRecipeId ?? null,
    });
    return this.insertRecipe({
      recipeSetId: input.recipeSetId,
      sessionId: input.sessionId,
      candidate,
      version: versionInput.version,
      parentRecipeId: versionInput.parentRecipeId,
      feedbackId: FeedbackIdSchema.parse(input.feedbackId ?? null),
      safetyLevel: candidate.safetyLevel,
    });
  }

  createSingleRecipeSet(input: CreateSingleRecipeSetInput): RecipeRecord {
    if (
      input.recipe.recipeSetId !== input.recipeSet.id ||
      input.recipe.sessionId !== input.recipeSet.sessionId
    ) {
      throw new RecipeDataIntegrityError();
    }

    const candidate = RecipeCandidateSchema.parse(input.recipe.candidate);
    const versionInput = CreateSingleRecipeVersionSchema.parse({
      version: input.recipe.version,
      parentRecipeId: input.recipe.parentRecipeId,
      feedbackId: input.recipe.feedbackId,
    });

    this.createRecipeSet(input.recipeSet);
    return this.insertRecipe({
      recipeSetId: input.recipeSet.id,
      sessionId: input.recipeSet.sessionId,
      candidate,
      version: versionInput.version,
      parentRecipeId: versionInput.parentRecipeId,
      feedbackId: versionInput.feedbackId,
      safetyLevel: candidate.safetyLevel,
    });
  }

  createBatch(input: CreateRecipeBatchInput): RecipeSetRecord {
    const sessionRepository = new DrizzleSessionRepository(this.database);
    const leaseNow = new Date();
    const acquisition = sessionRepository.acquireSessionMutationLease({
      sessionId: input.sessionId,
      requestId: input.requestId,
      expectedVersion: input.expectedVersion,
      leaseOwner: input.requestId,
      leaseExpiresAt: new Date(leaseNow.getTime() + 15_000),
      now: leaseNow,
    });
    if (acquisition.status === "version-conflict") {
      throw new SessionVersionConflictError();
    }
    if (acquisition.status === "busy") {
      throw new SessionMutationInProgressError();
    }

    const candidates = input.recipes.map((recipe) => RecipeCandidateSchema.parse(recipe.candidate));
    const candidateSet = RecipeCandidateSetSchema.parse({
      recipes: candidates,
      recommendedRecipeId: input.recommendedRecipeId,
    });
    const versions = input.recipes.map((recipe) =>
      CreateRecipeVersionSchema.parse({
        version: recipe.version ?? 1,
        parentRecipeId: recipe.parentRecipeId ?? null,
      }),
    );
    const safetyDecisions = input.safetyDecisions.map((decision) =>
      SafetyDecisionWriteSchema.parse(decision),
    );
    const event = DecisionEventWriteSchema.parse(input.event);
    const decisionByRecipeId = new Map(
      safetyDecisions.map((decision) => [decision.recipeId, decision]),
    );

    const recipeSetId = this.createRecipeSet({
      id: input.recipeSetId,
      sessionId: input.sessionId,
      sourceMode: input.sourceMode,
    });

    candidateSet.recipes.forEach((candidate, index) => {
      const decision = decisionByRecipeId.get(candidate.id);
      if (decision === undefined) {
        throw new Error("SAFETY_DECISION_MISSING");
      }

      const recipe = this.insertRecipe({
        recipeSetId,
        sessionId: input.sessionId,
        candidate,
        version: versions[index].version,
        parentRecipeId: versions[index].parentRecipeId,
        feedbackId: input.recipes[index]?.feedbackId ?? null,
        safetyLevel: decision.level,
      });
      this.insertSafetyDecision({ ...decision, recipeId: recipe.id });
    });
    this.setRecommendedRecipe(recipeSetId, candidateSet.recommendedRecipeId);
    this.createDecisionEvent({ sessionId: input.sessionId, event });
    sessionRepository.updateVersion({
      id: input.sessionId,
      expectedVersion: input.expectedVersion,
      leaseOwner: input.requestId,
      leaseNow,
      state: "RECIPE_SELECTION",
      currentStep: null,
    });

    sessionRepository.releaseSessionMutationLease({
      sessionId: input.sessionId,
      leaseOwner: input.requestId,
      now: new Date(),
    });

    const created = this.findSetBySession(input.sessionId);
    if (created === null) {
      throw new Error("RECIPE_SET_CREATE_FAILED");
    }
    return created;
  }

  findById(id: string): RecipeRecord | null {
    const row = this.database.select().from(recipes).where(eq(recipes.id, id)).get();
    return row === undefined ? null : toRecipeRecord(row);
  }

  findSetById(id: string): RecipeSetRecord | null {
    const row = this.database.select().from(recipeSets).where(eq(recipeSets.id, id)).get();
    return row === undefined ? null : toRecipeSetRecord(row);
  }

  findSetBySession(sessionId: string): RecipeSetRecord | null {
    const activeSet = this.findInitialRecipeSetRows(sessionId).at(-1);
    return activeSet === undefined ? null : toRecipeSetRecord(activeSet.recipeSet);
  }

  listBySession(sessionId: string): RecipeRecord[] {
    return this.database
      .select()
      .from(recipes)
      .where(eq(recipes.sessionId, sessionId))
      .orderBy(asc(recipes.version), asc(recipes.createdAt), asc(recipes.id))
      .all()
      .map(toRecipeRecord);
  }

  listBySet(recipeSetId: string): RecipeRecord[] {
    return this.database
      .select()
      .from(recipes)
      .where(eq(recipes.recipeSetId, recipeSetId))
      .orderBy(asc(recipes.strategy))
      .all()
      .map(toRecipeRecord);
  }

  findInitialRecipeSetBySession(sessionId: string): RecipeRecord[] {
    const candidateSets = this.findInitialRecipeSetRows(sessionId);

    if (candidateSets.length > 1) {
      throw new RecipeDataIntegrityError();
    }
    return candidateSets[0]?.recipes ?? [];
  }

  findCurrentRecipeBySession(sessionId: string): RecipeRecord | null {
    const session = this.database
      .select({ selectedRecipeId: sessions.selectedRecipeId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    if (session === undefined || session.selectedRecipeId === null) {
      return null;
    }

    const recipe = this.findById(session.selectedRecipeId);
    if (recipe === null || !this.recipeBelongsToSession(recipe, sessionId)) {
      throw new RecipeDataIntegrityError();
    }
    return recipe;
  }

  listRecipeVersionChain(recipeId: string): RecipeRecord[] {
    const startingRecipe = this.findById(recipeId);
    if (startingRecipe === null) {
      return [];
    }

    const reversedChain: RecipeRecord[] = [];
    const visited = new Set<string>();
    let current = startingRecipe;

    while (true) {
      if (visited.has(current.id)) {
        throw new RecipeDataIntegrityError();
      }
      visited.add(current.id);
      this.assertRecipeSetShape(current, current.sessionId);
      reversedChain.push(current);

      if (current.version === 1) {
        if (current.parentRecipeId !== null || current.feedbackId !== null) {
          throw new RecipeDataIntegrityError();
        }
        break;
      }

      if (current.version <= 1 || current.parentRecipeId === null || current.feedbackId === null) {
        throw new RecipeDataIntegrityError();
      }

      const feedbackRow = this.database
        .select({ sessionId: feedback.sessionId, recipeId: feedback.recipeId })
        .from(feedback)
        .where(eq(feedback.id, current.feedbackId))
        .get();
      if (
        feedbackRow === undefined ||
        feedbackRow.sessionId !== current.sessionId ||
        feedbackRow.recipeId !== current.parentRecipeId
      ) {
        throw new RecipeDataIntegrityError();
      }

      const parent = this.findById(current.parentRecipeId);
      if (
        parent === null ||
        !this.recipeBelongsToSession(parent, current.sessionId) ||
        parent.version !== current.version - 1
      ) {
        throw new RecipeDataIntegrityError();
      }
      current = parent;
    }

    return reversedChain.reverse();
  }

  listSafetyDecisionsBySet(recipeSetId: string): SafetyDecisionRecord[] {
    const recipeIds = this.database
      .select({ id: recipes.id })
      .from(recipes)
      .where(eq(recipes.recipeSetId, recipeSetId))
      .all()
      .map((row) => row.id);

    if (recipeIds.length === 0) {
      return [];
    }

    return this.database
      .select()
      .from(safetyDecisions)
      .where(inArray(safetyDecisions.recipeId, recipeIds))
      .orderBy(asc(safetyDecisions.createdAt))
      .all()
      .map(toSafetyDecisionRecord);
  }

  listDecisionEvents(sessionId: string): DecisionEventRecord[] {
    return this.database
      .select()
      .from(decisionEvents)
      .where(eq(decisionEvents.sessionId, sessionId))
      .orderBy(asc(decisionEvents.createdAt))
      .all()
      .map(toDecisionEventRecord);
  }

  createExperimentMemory(input: CreateExperimentMemoryInput): ExperimentMemoryRecord {
    const tags = TagsSchema.parse(input.tags);
    this.database
      .insert(experimentMemories)
      .values({
        id: input.id,
        recipeId: input.recipeId,
        feedbackId: input.feedbackId,
        summary: input.summary,
        tagsJson: JSON.stringify(tags),
      })
      .run();

    const row = this.database
      .select()
      .from(experimentMemories)
      .where(eq(experimentMemories.id, input.id))
      .get();
    if (row === undefined) {
      throw new Error("EXPERIMENT_MEMORY_CREATE_FAILED");
    }
    return toExperimentMemoryRecord(row);
  }

  listExperimentMemories(recipeId: string): ExperimentMemoryRecord[] {
    return this.database
      .select()
      .from(experimentMemories)
      .where(eq(experimentMemories.recipeId, recipeId))
      .orderBy(asc(experimentMemories.createdAt))
      .all()
      .map(toExperimentMemoryRecord);
  }

  private insertRecipe(input: {
    recipeSetId: string;
    sessionId: string;
    candidate: RecipeCandidate;
    version: number;
    parentRecipeId: string | null;
    feedbackId: string | null;
    safetyLevel: SafetyLevel;
  }): RecipeRecord {
    this.database
      .insert(recipes)
      .values({
        id: input.candidate.id,
        sessionId: input.sessionId,
        recipeSetId: input.recipeSetId,
        strategy: input.candidate.strategy,
        title: input.candidate.title,
        fitReason: input.candidate.fitReason,
        differenceReason: input.candidate.differenceReason,
        materialsJson: JSON.stringify(RecipeMaterialsSchema.parse(input.candidate.materials)),
        stepsJson: JSON.stringify(RecipeStepsSchema.parse(input.candidate.steps)),
        estimatedAbv: input.candidate.estimatedAbv,
        safetyLevel: SafetyLevelSchema.parse(input.safetyLevel),
        experimental: input.candidate.experimental,
        missingIngredientsJson: JSON.stringify(
          MissingIngredientsSchema.parse(input.candidate.missingIngredients),
        ),
        version: input.version,
        parentRecipeId: input.parentRecipeId,
        feedbackId: input.feedbackId,
      })
      .run();

    const row = this.database
      .select()
      .from(recipes)
      .where(eq(recipes.id, input.candidate.id))
      .get();
    if (row === undefined) {
      throw new Error("RECIPE_CREATE_FAILED");
    }
    return toRecipeRecord(row);
  }

  private insertSafetyDecision(input: SafetyDecisionWriteInput): string {
    const ruleHits = SafetyRuleHitsSchema.parse(input.ruleHits);
    const id = randomUUID();
    this.database
      .insert(safetyDecisions)
      .values({
        id,
        recipeId: input.recipeId,
        level: SafetyLevelSchema.parse(input.level),
        ruleHitsJson: JSON.stringify(ruleHits),
        engineVersion: input.engineVersion,
      })
      .run();
    return id;
  }

  createSafetyDecision(input: SafetyDecisionWriteInput): void {
    this.insertSafetyDecision(input);
  }

  setRecommendedRecipe(recipeSetId: string, recipeId: string): void {
    this.database
      .update(recipeSets)
      .set({ recommendedRecipeId: recipeId })
      .where(eq(recipeSets.id, recipeSetId))
      .run();
  }

  private createDecisionEvent(input: {
    sessionId: string;
    event: { type: string; summary: string; metadata: Record<string, unknown> };
  }): string {
    const id = randomUUID();
    this.database
      .insert(decisionEvents)
      .values({
        id,
        sessionId: input.sessionId,
        eventType: input.event.type,
        summary: input.event.summary,
        metadataJson: JSON.stringify(MetadataSchema.parse(input.event.metadata)),
      })
      .run();
    return id;
  }

  private recipeBelongsToSession(recipe: RecipeRecord, sessionId: string): boolean {
    const recipeSet = this.database
      .select({ sessionId: recipeSets.sessionId })
      .from(recipeSets)
      .where(eq(recipeSets.id, recipe.recipeSetId))
      .get();
    return (
      recipe.sessionId === sessionId && recipeSet !== undefined && recipeSet.sessionId === sessionId
    );
  }

  private assertRecipeSetShape(recipe: RecipeRecord, sessionId: string): void {
    if (!this.recipeBelongsToSession(recipe, sessionId)) {
      throw new RecipeDataIntegrityError();
    }

    const recipesInSet = this.listBySet(recipe.recipeSetId);
    if (recipe.version === 1) {
      if (!isInitialRecipeSet(recipe.recipeSetId, sessionId, recipesInSet)) {
        throw new RecipeDataIntegrityError();
      }
      return;
    }

    if (recipesInSet.length !== 1) {
      throw new RecipeDataIntegrityError();
    }
  }

  private findInitialRecipeSetRows(sessionId: string): Array<{
    recipeSet: typeof recipeSets.$inferSelect;
    recipes: RecipeRecord[];
  }> {
    return this.database
      .select()
      .from(recipeSets)
      .where(eq(recipeSets.sessionId, sessionId))
      .orderBy(sql`rowid`)
      .all()
      .map((recipeSet) => ({ recipeSet, recipes: this.listBySet(recipeSet.id) }))
      .filter(({ recipeSet, recipes: recipeRows }) =>
        isInitialRecipeSet(recipeSet.id, sessionId, recipeRows),
      );
  }
}

function isInitialRecipeSet(
  recipeSetId: string,
  sessionId: string,
  recipesInSet: readonly RecipeRecord[],
): boolean {
  const strategies = new Set(recipesInSet.map((recipe) => recipe.strategy));
  return (
    recipesInSet.length === 3 &&
    recipesInSet.every(
      (recipe) =>
        recipe.recipeSetId === recipeSetId &&
        recipe.sessionId === sessionId &&
        recipe.version === 1 &&
        recipe.parentRecipeId === null &&
        recipe.feedbackId === null,
    ) &&
    strategies.size === 3 &&
    strategies.has("A_CONSERVATIVE") &&
    strategies.has("B_CREATIVE") &&
    strategies.has("C_UPGRADE")
  );
}

import { randomUUID } from "node:crypto";

import { z } from "zod";

import { assertIdempotencyFingerprint, fingerprintRequest } from "@/src/application/idempotency";
import { MutationMetaSchema, SuccessEnvelopeSchema } from "@/src/domain/api";
import { SessionIdSchema } from "@/src/domain/id";
import type { RecipeRepository } from "@/src/repositories/recipe-repository";
import {
  SessionNotFoundError,
  type SessionMutationLeaseRepository,
  SessionVersionConflictError,
  type SessionRepository,
} from "@/src/repositories/session-repository";
import { SessionEvent, transition } from "@/src/workflow/session-machine";
import { VersionConflictError } from "@/src/application/save-preferences";
import { acquireSessionMutationLease } from "@/src/application/session-mutation-lease";

const SelectRecipeInputSchema = MutationMetaSchema.extend({
  sessionId: SessionIdSchema,
  recipeId: z.string().uuid(),
  warningAcknowledged: z.boolean().default(false),
}).strict();

const SelectRecipeResponseSchema = SuccessEnvelopeSchema(
  z
    .object({
      recipeId: z.string().uuid(),
      currentStep: z.number().int().nonnegative(),
      totalSteps: z.number().int().positive(),
      warningAcknowledged: z.boolean(),
    })
    .strict(),
);

export type SelectRecipeInput = z.input<typeof SelectRecipeInputSchema>;
export type SelectRecipeResponse = z.infer<typeof SelectRecipeResponseSchema>;

export interface SelectRecipeResult {
  requestId: string;
  response: SelectRecipeResponse;
  replayed: boolean;
}

export type SelectRecipeReadRepository = SessionRepository &
  Pick<RecipeRepository, "findSetBySession" | "listBySet" | "listSafetyDecisionsBySet">;
export type SelectRecipeTransactionRepository = SessionRepository &
  SessionMutationLeaseRepository &
  Pick<RecipeRepository, "findSetBySession" | "listBySet" | "listSafetyDecisionsBySet">;

export interface SelectRecipeDependencies {
  read(): SelectRecipeReadRepository;
  transaction<T>(operation: (repository: SelectRecipeTransactionRepository) => T): T;
}

export class WarningAcknowledgementRequiredError extends Error {
  readonly code = "WARNING_ACKNOWLEDGEMENT_REQUIRED";

  constructor() {
    super("WARNING_ACKNOWLEDGEMENT_REQUIRED");
    this.name = "WarningAcknowledgementRequiredError";
  }
}

export class BlockedRecipeSelectionError extends Error {
  readonly code = "RECIPE_BLOCKED";

  constructor() {
    super("RECIPE_BLOCKED");
    this.name = "BlockedRecipeSelectionError";
  }
}

export class RecipeSelectionNotFoundError extends Error {
  readonly code = "RECIPE_NOT_FOUND";

  constructor() {
    super("RECIPE_NOT_FOUND");
    this.name = "RecipeSelectionNotFoundError";
  }
}

export class RecipeSafetyInvariantError extends Error {
  readonly code = "RECIPE_SAFETY_INVARIANT";

  constructor() {
    super("RECIPE_SAFETY_INVARIANT");
    this.name = "RecipeSafetyInvariantError";
  }
}

function parseStoredResponse(response: Record<string, unknown>): SelectRecipeResponse {
  return SelectRecipeResponseSchema.parse(response);
}

function resolvePersistedSafetyLevel(
  selectedRecipe: { id: string; safetyLevel: "ALLOW" | "WARN" | "BLOCK" },
  safetyDecisions: readonly { recipeId: string; level: "ALLOW" | "WARN" | "BLOCK" }[],
): "ALLOW" | "WARN" | "BLOCK" {
  const matchingDecisions = safetyDecisions.filter(
    (decision) => decision.recipeId === selectedRecipe.id,
  );

  if (matchingDecisions.length !== 1) {
    throw new RecipeSafetyInvariantError();
  }
  if (matchingDecisions[0]?.level !== selectedRecipe.safetyLevel) {
    throw new RecipeSafetyInvariantError();
  }

  return matchingDecisions[0].level;
}

function releaseLeaseIfHeld(
  repository: SelectRecipeTransactionRepository,
  input: { sessionId: string; leaseOwner: string; leaseHeld: boolean },
): boolean {
  if (!input.leaseHeld) {
    return false;
  }

  repository.releaseSessionMutationLease({
    sessionId: input.sessionId,
    leaseOwner: input.leaseOwner,
    now: new Date(),
  });
  return false;
}

export function selectRecipe(
  dependencies: SelectRecipeDependencies,
  input: unknown,
): SelectRecipeResult {
  const parsed = SelectRecipeInputSchema.parse(input);
  const requestFingerprint = fingerprintRequest({
    operation: "select-recipe",
    sessionId: parsed.sessionId,
    expectedVersion: parsed.expectedVersion,
    recipeId: parsed.recipeId,
    warningAcknowledged: parsed.warningAcknowledged,
  });
  const existing = dependencies.read().findIdempotencyRecordByRequestId(parsed.requestId);

  if (existing !== null) {
    assertIdempotencyFingerprint(existing, requestFingerprint);
    return {
      requestId: parsed.requestId,
      response: parseStoredResponse(existing.response),
      replayed: true,
    };
  }

  return dependencies.transaction((repository) => {
    let leaseHeld = false;
    const transactionExisting = repository.findIdempotencyRecordByRequestId(parsed.requestId);
    if (transactionExisting !== null) {
      assertIdempotencyFingerprint(transactionExisting, requestFingerprint);
      return {
        requestId: parsed.requestId,
        response: parseStoredResponse(transactionExisting.response),
        replayed: true,
      };
    }

    try {
      acquireSessionMutationLease(repository, {
        sessionId: parsed.sessionId,
        requestId: parsed.requestId,
        expectedVersion: parsed.expectedVersion,
        leaseOwner: parsed.requestId,
      });
      leaseHeld = true;
    } catch (error) {
      if (error instanceof SessionVersionConflictError) {
        throw new VersionConflictError();
      }
      throw error;
    }

    const session = repository.findById(parsed.sessionId);
    if (session === null) {
      throw new SessionNotFoundError();
    }
    if (session.version !== parsed.expectedVersion) {
      throw new VersionConflictError();
    }

    const recipeSet = repository.findSetBySession(parsed.sessionId);
    if (recipeSet === null) {
      try {
        throw new RecipeSelectionNotFoundError();
      } finally {
        leaseHeld = releaseLeaseIfHeld(repository, {
          sessionId: parsed.sessionId,
          leaseOwner: parsed.requestId,
          leaseHeld,
        });
      }
    }
    const availableRecipes = repository.listBySet(recipeSet.id);
    const selectedRecipe = availableRecipes.find((recipe) => recipe.id === parsed.recipeId);
    if (selectedRecipe === undefined) {
      try {
        throw new RecipeSelectionNotFoundError();
      } finally {
        leaseHeld = releaseLeaseIfHeld(repository, {
          sessionId: parsed.sessionId,
          leaseOwner: parsed.requestId,
          leaseHeld,
        });
      }
    }
    const persistedSafetyLevel = (() => {
      try {
        return resolvePersistedSafetyLevel(
          selectedRecipe,
          repository.listSafetyDecisionsBySet(recipeSet.id),
        );
      } catch (error) {
        leaseHeld = releaseLeaseIfHeld(repository, {
          sessionId: parsed.sessionId,
          leaseOwner: parsed.requestId,
          leaseHeld,
        });
        throw error;
      }
    })();
    if (persistedSafetyLevel === "BLOCK") {
      try {
        throw new BlockedRecipeSelectionError();
      } finally {
        leaseHeld = releaseLeaseIfHeld(repository, {
          sessionId: parsed.sessionId,
          leaseOwner: parsed.requestId,
          leaseHeld,
        });
      }
    }
    if (persistedSafetyLevel === "WARN" && parsed.warningAcknowledged !== true) {
      try {
        throw new WarningAcknowledgementRequiredError();
      } finally {
        leaseHeld = releaseLeaseIfHeld(repository, {
          sessionId: parsed.sessionId,
          leaseOwner: parsed.requestId,
          leaseHeld,
        });
      }
    }

    const nextState = transition(session.state, SessionEvent.SELECT_RECIPE, {
      hasPreferences: session.preferences !== null,
      hasOverviewImage: true,
      allIngredientsConfirmed: true,
      alcoholAbvConfirmed: true,
      hasRecipeSet: true,
      hasSelectedRecipe: true,
      hasSelectedAdjustedRecipe: false,
      currentStep: 0,
      totalSteps: selectedRecipe.steps.length,
      hasFeedback: false,
    });

    let updated;
    try {
      updated = repository.updateVersion({
        id: parsed.sessionId,
        expectedVersion: parsed.expectedVersion,
        leaseOwner: parsed.requestId,
        state: nextState,
        selectedRecipeId: parsed.recipeId,
        currentStep: 0,
      });
    } catch (error) {
      if (error instanceof SessionVersionConflictError) {
        throw new VersionConflictError();
      }
      throw error;
    }

    const response: SelectRecipeResponse = {
      data: {
        recipeId: parsed.recipeId,
        currentStep: 0,
        totalSteps: selectedRecipe.steps.length,
        warningAcknowledged: parsed.warningAcknowledged,
      },
      session: {
        id: parsed.sessionId,
        state: updated.state,
        version: updated.version,
      },
    };

    repository.saveIdempotencyRecord({
      id: randomUUID(),
      sessionId: updated.id,
      requestId: parsed.requestId,
      requestFingerprint,
      response,
      statusCode: 200,
    });
    repository.releaseSessionMutationLease({
      sessionId: parsed.sessionId,
      leaseOwner: parsed.requestId,
      now: new Date(),
    });
    leaseHeld = false;

    return {
      requestId: parsed.requestId,
      response,
      replayed: false,
    };
  });
}

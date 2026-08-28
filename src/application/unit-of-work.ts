import { parseEnv } from "@/src/config/env";
import type { AppDatabase } from "@/src/infrastructure/db/client";
import { createDatabase } from "@/src/infrastructure/db/client";
import { withTransaction } from "@/src/infrastructure/db/transaction";
import type { DatabaseExecutor } from "@/src/infrastructure/db/transaction";
import { DrizzleImageUploadRepository } from "@/src/infrastructure/repositories/drizzle-image-upload-repository";
import { DrizzleIngredientRepository } from "@/src/infrastructure/repositories/drizzle-ingredient-repository";
import { DrizzleDecisionEventRepository } from "@/src/infrastructure/repositories/drizzle-decision-event-repository";
import { DrizzleFeedbackRepository } from "@/src/infrastructure/repositories/drizzle-feedback-repository";
import { DrizzleSessionRepository } from "@/src/infrastructure/repositories/drizzle-session-repository";
import type { ImageRepository } from "@/src/repositories/image-repository";
import type { IngredientRepository } from "@/src/repositories/ingredient-repository";
import type { DecisionEventRepository } from "@/src/repositories/decision-event-repository";
import type { FeedbackRepository } from "@/src/repositories/feedback-repository";
import type { IdempotencyReservationRepository } from "@/src/repositories/idempotency-reservation-repository";
import type { SessionRepository } from "@/src/repositories/session-repository";
import type { SessionMutationLeaseRepository } from "@/src/repositories/session-repository";
import { DrizzleRecipeRepository } from "@/src/infrastructure/repositories/drizzle-recipe-repository";
import type { RecipeRepository } from "@/src/repositories/recipe-repository";

export type SessionTransactionRepository = SessionRepository &
  ImageRepository &
  SessionMutationLeaseRepository & {
    findRecipeById(id: string): ReturnType<RecipeRepository["findById"]>;
  };
export type VisionReadRepository = SessionRepository & ImageRepository & IngredientRepository;
export type VisionTransactionRepository = SessionTransactionRepository &
  IngredientRepository &
  DecisionEventRepository &
  IdempotencyReservationRepository;

export type FeedbackReadRepository = {
  findSessionById: SessionRepository["findById"];
  findIdempotencyRecordByRequestId: SessionRepository["findIdempotencyRecordByRequestId"];
  findRecipeById: RecipeRepository["findById"];
  findFeedbackById: FeedbackRepository["findById"];
  listFeedbackByRecipe: FeedbackRepository["listByRecipe"];
  findImageById: ImageRepository["findImageById"];
};
export type FeedbackTransactionRepository = FeedbackReadRepository &
  SessionMutationLeaseRepository &
  Pick<SessionRepository, "updateVersion" | "saveIdempotencyRecord"> &
  Pick<FeedbackRepository, "create"> &
  Pick<RecipeRepository, "createExperimentMemory"> &
  DecisionEventRepository;

export interface FeedbackUnitOfWork {
  read(): FeedbackReadRepository;
  transaction<T>(operation: (repository: FeedbackTransactionRepository) => T): T;
}

export type AdjustmentReadRepository = FeedbackReadRepository & {
  listRecipesBySession: RecipeRepository["listBySession"];
  findRecipeSetById: RecipeRepository["findSetById"];
  listRecipesBySet: RecipeRepository["listBySet"];
  listRecipeVersionChain: RecipeRepository["listRecipeVersionChain"];
  listIngredientsBySession: IngredientRepository["listBySession"];
  listSafetyDecisionsBySet: RecipeRepository["listSafetyDecisionsBySet"];
  listExperimentMemories: RecipeRepository["listExperimentMemories"];
};
export type AdjustmentTransactionRepository = AdjustmentReadRepository &
  SessionMutationLeaseRepository &
  IdempotencyReservationRepository & {
    updateVersion: SessionRepository["updateVersion"];
    createFeedback: FeedbackRepository["create"];
    createSingleRecipeSet: RecipeRepository["createSingleRecipeSet"];
    createSafetyDecision: RecipeRepository["createSafetyDecision"];
    createExperimentMemory: RecipeRepository["createExperimentMemory"];
    createDecisionEvent: DecisionEventRepository["createDecisionEvent"];
  };

export interface AdjustmentUnitOfWork {
  read(): AdjustmentReadRepository;
  transaction<T>(operation: (repository: AdjustmentTransactionRepository) => T): T;
}

export interface SessionUnitOfWork {
  read(): SessionRepository;
  transaction<T>(operation: (repository: SessionTransactionRepository) => T): T;
}

export interface VisionUnitOfWork extends SessionUnitOfWork {
  readVision(): VisionReadRepository;
  transactionVision<T>(operation: (repository: VisionTransactionRepository) => T): T;
}

function createTransactionRepository(database: DatabaseExecutor): SessionTransactionRepository {
  const sessionRepository = new DrizzleSessionRepository(database);
  const imageRepository = new DrizzleImageUploadRepository(database);
  const recipeRepository = new DrizzleRecipeRepository(database);

  return {
    create: (input) => sessionRepository.create(input),
    findById: (id) => sessionRepository.findById(id),
    updateVersion: (input) => sessionRepository.updateVersion(input),
    saveIdempotencyRecord: (input) => sessionRepository.saveIdempotencyRecord(input),
    findIdempotencyRecord: (sessionId, requestId) =>
      sessionRepository.findIdempotencyRecord(sessionId, requestId),
    findIdempotencyRecordByRequestId: (requestId) =>
      sessionRepository.findIdempotencyRecordByRequestId(requestId),
    acquireSessionMutationLease: (input) => sessionRepository.acquireSessionMutationLease(input),
    assertSessionMutationLease: (input) => sessionRepository.assertSessionMutationLease(input),
    renewSessionMutationLease: (input) => sessionRepository.renewSessionMutationLease(input),
    releaseSessionMutationLease: (input) => sessionRepository.releaseSessionMutationLease(input),
    createImage: (input) => imageRepository.createImage(input),
    updateImage: (input) => imageRepository.updateImage(input),
    findImageById: (id) => imageRepository.findImageById(id),
    findMixingStepImage: (sessionId, recipeId, stepIndex) =>
      imageRepository.findMixingStepImage(sessionId, recipeId, stepIndex),
    listImagesBySession: (sessionId) => imageRepository.listImagesBySession(sessionId),
    findRecipeById: (id) => recipeRepository.findById(id),
  };
}

function createVisionReadRepository(database: DatabaseExecutor): VisionReadRepository {
  const sessionRepository = new DrizzleSessionRepository(database);
  const imageRepository = new DrizzleImageUploadRepository(database);
  const ingredientRepository = new DrizzleIngredientRepository(database);

  return {
    create: (input) => sessionRepository.create(input),
    findById: (id) => sessionRepository.findById(id),
    updateVersion: (input) => sessionRepository.updateVersion(input),
    saveIdempotencyRecord: (input) => sessionRepository.saveIdempotencyRecord(input),
    findIdempotencyRecord: (sessionId, requestId) =>
      sessionRepository.findIdempotencyRecord(sessionId, requestId),
    findIdempotencyRecordByRequestId: (requestId) =>
      sessionRepository.findIdempotencyRecordByRequestId(requestId),
    createImage: (input) => imageRepository.createImage(input),
    findImageById: (id) => imageRepository.findImageById(id),
    updateImage: (input) => imageRepository.updateImage(input),
    findMixingStepImage: (sessionId, recipeId, stepIndex) =>
      imageRepository.findMixingStepImage(sessionId, recipeId, stepIndex),
    listImagesBySession: (sessionId) => imageRepository.listImagesBySession(sessionId),
    listBySession: (sessionId) => ingredientRepository.listBySession(sessionId),
    replaceForSession: (input) => ingredientRepository.replaceForSession(input),
  };
}

function createVisionTransactionRepository(
  database: DatabaseExecutor,
): VisionTransactionRepository {
  const base = createTransactionRepository(database);
  const sessionRepository = new DrizzleSessionRepository(database);
  const ingredientRepository = new DrizzleIngredientRepository(database);
  const decisionEventRepository = new DrizzleDecisionEventRepository(database);

  return {
    ...base,
    listBySession: (sessionId) => ingredientRepository.listBySession(sessionId),
    replaceForSession: (input) => ingredientRepository.replaceForSession(input),
    createDecisionEvent: (input) => decisionEventRepository.createDecisionEvent(input),
    acquireIdempotencyLease: (input) => sessionRepository.acquireIdempotencyLease(input),
    assertIdempotencyLease: (input) => sessionRepository.assertIdempotencyLease(input),
    renewIdempotencyLease: (input) => sessionRepository.renewIdempotencyLease(input),
    completeIdempotencyRecord: (input) => sessionRepository.completeIdempotencyRecord(input),
    deleteIdempotencyRecord: (input) => sessionRepository.deleteIdempotencyRecord(input),
  };
}

function createFeedbackReadRepository(database: DatabaseExecutor): FeedbackReadRepository {
  const sessionRepository = new DrizzleSessionRepository(database);
  const feedbackRepository = new DrizzleFeedbackRepository(database);
  const recipeRepository = new DrizzleRecipeRepository(database);
  const imageRepository = new DrizzleImageUploadRepository(database);

  return {
    findSessionById: (id) => sessionRepository.findById(id),
    findIdempotencyRecordByRequestId: (requestId) =>
      sessionRepository.findIdempotencyRecordByRequestId(requestId),
    findRecipeById: (id) => recipeRepository.findById(id),
    findFeedbackById: (id) => feedbackRepository.findById(id),
    listFeedbackByRecipe: (recipeId) => feedbackRepository.listByRecipe(recipeId),
    findImageById: (id) => imageRepository.findImageById(id),
  };
}

function createFeedbackTransactionRepository(
  database: DatabaseExecutor,
): FeedbackTransactionRepository {
  const sessionRepository = new DrizzleSessionRepository(database);
  const feedbackRepository = new DrizzleFeedbackRepository(database);
  const recipeRepository = new DrizzleRecipeRepository(database);
  const decisionEventRepository = new DrizzleDecisionEventRepository(database);

  return {
    ...createFeedbackReadRepository(database),
    acquireSessionMutationLease: (input) => sessionRepository.acquireSessionMutationLease(input),
    assertSessionMutationLease: (input) => sessionRepository.assertSessionMutationLease(input),
    renewSessionMutationLease: (input) => sessionRepository.renewSessionMutationLease(input),
    releaseSessionMutationLease: (input) => sessionRepository.releaseSessionMutationLease(input),
    updateVersion: (input) => sessionRepository.updateVersion(input),
    saveIdempotencyRecord: (input) => sessionRepository.saveIdempotencyRecord(input),
    create: (input) => feedbackRepository.create(input),
    createExperimentMemory: (input) => recipeRepository.createExperimentMemory(input),
    createDecisionEvent: (input) => decisionEventRepository.createDecisionEvent(input),
  };
}

function createAdjustmentReadRepository(database: DatabaseExecutor): AdjustmentReadRepository {
  const sessionRepository = new DrizzleSessionRepository(database);
  const feedbackRepository = new DrizzleFeedbackRepository(database);
  const recipeRepository = new DrizzleRecipeRepository(database);
  const ingredientRepository = new DrizzleIngredientRepository(database);
  const imageRepository = new DrizzleImageUploadRepository(database);

  return {
    findSessionById: (id) => sessionRepository.findById(id),
    findIdempotencyRecordByRequestId: (requestId) =>
      sessionRepository.findIdempotencyRecordByRequestId(requestId),
    findRecipeById: (id) => recipeRepository.findById(id),
    findFeedbackById: (id) => feedbackRepository.findById(id),
    listFeedbackByRecipe: (recipeId) => feedbackRepository.listByRecipe(recipeId),
    findImageById: (id) => imageRepository.findImageById(id),
    listRecipesBySession: (sessionId) => recipeRepository.listBySession(sessionId),
    findRecipeSetById: (id) => recipeRepository.findSetById(id),
    listRecipesBySet: (recipeSetId) => recipeRepository.listBySet(recipeSetId),
    listRecipeVersionChain: (recipeId) => recipeRepository.listRecipeVersionChain(recipeId),
    listIngredientsBySession: (sessionId) => ingredientRepository.listBySession(sessionId),
    listSafetyDecisionsBySet: (recipeSetId) =>
      recipeRepository.listSafetyDecisionsBySet(recipeSetId),
    listExperimentMemories: (recipeId) => recipeRepository.listExperimentMemories(recipeId),
  };
}

function createAdjustmentTransactionRepository(
  database: DatabaseExecutor,
): AdjustmentTransactionRepository {
  const sessionRepository = new DrizzleSessionRepository(database);
  const feedbackRepository = new DrizzleFeedbackRepository(database);
  const recipeRepository = new DrizzleRecipeRepository(database);
  const decisionEventRepository = new DrizzleDecisionEventRepository(database);

  return {
    ...createAdjustmentReadRepository(database),
    acquireSessionMutationLease: (input) => sessionRepository.acquireSessionMutationLease(input),
    assertSessionMutationLease: (input) => sessionRepository.assertSessionMutationLease(input),
    renewSessionMutationLease: (input) => sessionRepository.renewSessionMutationLease(input),
    releaseSessionMutationLease: (input) => sessionRepository.releaseSessionMutationLease(input),
    acquireIdempotencyLease: (input) => sessionRepository.acquireIdempotencyLease(input),
    assertIdempotencyLease: (input) => sessionRepository.assertIdempotencyLease(input),
    renewIdempotencyLease: (input) => sessionRepository.renewIdempotencyLease(input),
    completeIdempotencyRecord: (input) => sessionRepository.completeIdempotencyRecord(input),
    deleteIdempotencyRecord: (input) => sessionRepository.deleteIdempotencyRecord(input),
    saveIdempotencyRecord: (input) => sessionRepository.saveIdempotencyRecord(input),
    updateVersion: (input) => sessionRepository.updateVersion(input),
    createFeedback: (input) => feedbackRepository.create(input),
    createSingleRecipeSet: (input) => recipeRepository.createSingleRecipeSet(input),
    createSafetyDecision: (input) => recipeRepository.createSafetyDecision(input),
    createExperimentMemory: (input) => recipeRepository.createExperimentMemory(input),
    createDecisionEvent: (input) => decisionEventRepository.createDecisionEvent(input),
  };
}

export function createAdjustmentUnitOfWork(database: AppDatabase): AdjustmentUnitOfWork {
  return {
    read: () => createAdjustmentReadRepository(database),
    transaction: (operation) =>
      withTransaction(database, (transaction) =>
        operation(createAdjustmentTransactionRepository(transaction)),
      ),
  };
}

export function createFeedbackUnitOfWork(database: AppDatabase): FeedbackUnitOfWork {
  return {
    read: () => createFeedbackReadRepository(database),
    transaction: (operation) =>
      withTransaction(database, (transaction) =>
        operation(createFeedbackTransactionRepository(transaction)),
      ),
  };
}

export function createSessionUnitOfWork(database: AppDatabase): VisionUnitOfWork {
  return {
    read: () => new DrizzleSessionRepository(database),
    transaction: (operation) =>
      withTransaction(database, (transaction) =>
        operation(createTransactionRepository(transaction)),
      ),
    readVision: () => createVisionReadRepository(database),
    transactionVision: (operation) =>
      withTransaction(database, (transaction) =>
        operation(createVisionTransactionRepository(transaction)),
      ),
  };
}

let defaultUnitOfWork: VisionUnitOfWork | null = null;

export function getDefaultSessionUnitOfWork(): VisionUnitOfWork {
  if (defaultUnitOfWork === null) {
    const environment = parseEnv();
    const database = createDatabase(environment.DATABASE_PATH);
    database.applyMigrations();
    defaultUnitOfWork = createSessionUnitOfWork(database.db);
  }

  return defaultUnitOfWork;
}

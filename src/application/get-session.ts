import { z } from "zod";

import type { VisionUnitOfWork } from "@/src/application/unit-of-work";
import { DetectedIngredientSchema, type DetectedIngredient } from "@/src/domain/ingredient";
import { SessionIdSchema } from "@/src/domain/id";
import { ImageRoleSchema } from "@/src/providers/image-store";
import type { ImageRecord } from "@/src/repositories/image-repository";
import { SessionNotFoundError } from "@/src/repositories/session-repository";

const GetSessionInputSchema = z.object({
  sessionId: SessionIdSchema,
});

export type GetSessionInput = z.input<typeof GetSessionInputSchema>;

export interface SessionSnapshot {
  id: string;
  state: string;
  version: number;
  preferences: {
    sweetness: 1 | 2 | 3 | 4 | 5;
    acidity: 1 | 2 | 3 | 4 | 5;
    alcoholIntensity: 1 | 2 | 3 | 4 | 5;
    body: 1 | 2 | 3 | 4 | 5;
  } | null;
  selectedRecipeId: string | null;
  currentStep: number | null;
  ingredients: readonly DetectedIngredient[];
  mixingPhotos: readonly MixingPhotoSnapshot[];
}

export interface MixingPhotoSnapshot {
  imageId: string;
  role: "mixing_step";
  recipeId: string;
  stepIndex: number;
  mime: "image/jpeg";
  width: number;
  height: number;
}

export function getSession(unitOfWork: VisionUnitOfWork, input: GetSessionInput): SessionSnapshot {
  const parsed = GetSessionInputSchema.parse(input);
  const session = unitOfWork.read().findById(parsed.sessionId);

  if (session === null) {
    throw new SessionNotFoundError();
  }

  return {
    id: session.id,
    state: session.state,
    version: session.version,
    preferences: session.preferences,
    selectedRecipeId: session.selectedRecipeId,
    currentStep: session.currentStep,
    ingredients: unitOfWork.readVision().listBySession(parsed.sessionId).map(toSnapshotIngredient),
    mixingPhotos: unitOfWork
      .readVision()
      .listImagesBySession(parsed.sessionId)
      .filter(
        (image) => image.role === "mixing_step" && image.recipeId === session.selectedRecipeId,
      )
      .map(toSnapshotMixingPhoto),
  };
}

function toSnapshotIngredient(input: DetectedIngredient): DetectedIngredient {
  return DetectedIngredientSchema.parse({
    rawName: input.rawName,
    canonicalName: input.canonicalName,
    category: input.category,
    brand: input.brand,
    abv: input.abv,
    confidence: input.confidence,
    confirmed: input.confirmed,
  });
}

function toSnapshotMixingPhoto(input: ImageRecord): MixingPhotoSnapshot {
  if (
    ImageRoleSchema.parse(input.role) !== "mixing_step" ||
    input.recipeId === null ||
    input.stepIndex === null ||
    input.mime !== "image/jpeg"
  ) {
    throw new Error("MIXING_IMAGE_DATA_INTEGRITY");
  }

  return {
    imageId: input.id,
    role: "mixing_step",
    recipeId: input.recipeId,
    stepIndex: input.stepIndex,
    mime: input.mime,
    width: input.width,
    height: input.height,
  };
}

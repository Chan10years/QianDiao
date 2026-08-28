import type { DetectedIngredient } from "@/src/domain/ingredient";

export interface IngredientRecord extends DetectedIngredient {
  id: string;
  sessionId: string;
  createdAt: Date;
}

export interface ReplaceIngredientsInput {
  sessionId: string;
  ingredients: readonly DetectedIngredient[];
}

export interface IngredientRepository {
  listBySession(sessionId: string): IngredientRecord[];
  replaceForSession(input: ReplaceIngredientsInput): IngredientRecord[];
}

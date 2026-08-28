import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { DetectedIngredientSchema, IngredientCategorySchema } from "@/src/domain/ingredient";
import type { DatabaseExecutor } from "@/src/infrastructure/db/transaction";
import { ingredients } from "@/src/infrastructure/db/schema";
import type {
  IngredientRecord,
  IngredientRepository,
  ReplaceIngredientsInput,
} from "@/src/repositories/ingredient-repository";

const IngredientsSchema = z.array(DetectedIngredientSchema).min(1).max(50);

function toIngredientRecord(row: typeof ingredients.$inferSelect): IngredientRecord {
  const ingredient = DetectedIngredientSchema.parse({
    rawName: row.rawName,
    canonicalName: row.canonicalName,
    category: IngredientCategorySchema.parse(row.category),
    brand: row.brand,
    abv: row.abv,
    confidence: row.confidence,
    confirmed: row.confirmed,
  });

  return {
    ...ingredient,
    id: row.id,
    sessionId: row.sessionId,
    createdAt: row.createdAt,
  };
}

export class DrizzleIngredientRepository implements IngredientRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  listBySession(sessionId: string): IngredientRecord[] {
    return this.database
      .select()
      .from(ingredients)
      .where(eq(ingredients.sessionId, sessionId))
      .orderBy(asc(ingredients.createdAt), asc(ingredients.canonicalName))
      .all()
      .map(toIngredientRecord);
  }

  replaceForSession(input: ReplaceIngredientsInput): IngredientRecord[] {
    const parsedIngredients = IngredientsSchema.parse(input.ingredients);
    this.database.delete(ingredients).where(eq(ingredients.sessionId, input.sessionId)).run();

    this.database
      .insert(ingredients)
      .values(
        parsedIngredients.map((ingredient) => ({
          id: randomUUID(),
          sessionId: input.sessionId,
          rawName: ingredient.rawName,
          canonicalName: ingredient.canonicalName,
          category: ingredient.category,
          brand: ingredient.brand,
          abv: ingredient.abv,
          confidence: ingredient.confidence,
          confirmed: ingredient.confirmed,
        })),
      )
      .run();

    return this.listBySession(input.sessionId);
  }
}

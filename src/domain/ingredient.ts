import { z } from "zod";

const ingredientNameSchema = z.string().trim().min(1).max(100);

export const IngredientCategorySchema = z.enum([
  "spirit",
  "mixer",
  "tea",
  "fruit",
  "sweetener",
  "herb",
  "ice",
  "energy_drink",
  "medicine",
  "non_food",
  "unknown",
]);

export const DetectedIngredientSchema = z
  .object({
    rawName: ingredientNameSchema,
    canonicalName: ingredientNameSchema,
    category: IngredientCategorySchema,
    brand: ingredientNameSchema.nullable(),
    abv: z.number().finite().min(0).max(100).nullable(),
    confidence: z.number().finite().min(0).max(1),
    confirmed: z.boolean(),
  })
  .strict();

export type IngredientCategory = z.infer<typeof IngredientCategorySchema>;
export type DetectedIngredient = z.infer<typeof DetectedIngredientSchema>;

import { z } from "zod";

export const TasteLevelSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

export const TasteProfileSchema = z
  .object({
    sweetness: TasteLevelSchema,
    acidity: TasteLevelSchema,
    alcoholIntensity: TasteLevelSchema,
    body: TasteLevelSchema,
  })
  .strict();

export type TasteLevel = z.infer<typeof TasteLevelSchema>;
export type TasteProfile = z.infer<typeof TasteProfileSchema>;

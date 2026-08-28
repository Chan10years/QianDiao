import { z } from "zod";

export const FeedbackDeltaSchema = z.union([
  z.literal(-2),
  z.literal(-1),
  z.literal(0),
  z.literal(1),
  z.literal(2),
]);

export const FeedbackDeltasSchema = z
  .object({
    sweetness: FeedbackDeltaSchema,
    acidity: FeedbackDeltaSchema,
    alcoholIntensity: FeedbackDeltaSchema,
    body: FeedbackDeltaSchema,
  })
  .strict();

export const FeedbackSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    accepted: z.boolean(),
    deltas: FeedbackDeltasSchema,
    notes: z.string().max(2000).optional(),
    finalImageId: z.string().uuid().nullable().optional(),
  })
  .strict();

export type FeedbackDelta = z.infer<typeof FeedbackDeltaSchema>;
export type FeedbackDeltas = z.infer<typeof FeedbackDeltasSchema>;
export type Feedback = z.infer<typeof FeedbackSchema>;

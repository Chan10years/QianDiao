import { z } from "zod";

export const SessionStateSchema = z.enum([
  "PREFERENCES",
  "SCAN",
  "CONFIRM",
  "READY",
  "RECIPE_SELECTION",
  "MIXING",
  "FEEDBACK",
  "ADJUSTMENT",
  "COMPLETED",
]);

export const SessionVersionSchema = z.number().int().nonnegative();
export const MixingActionSchema = z.enum(["ADVANCE_MIXING", "BACK_MIXING"]);

export type SessionState = z.infer<typeof SessionStateSchema>;
export type SessionVersion = z.infer<typeof SessionVersionSchema>;
export type MixingAction = z.infer<typeof MixingActionSchema>;

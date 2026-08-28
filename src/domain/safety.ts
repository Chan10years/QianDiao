import { z } from "zod";

export const SafetyLevelSchema = z.enum(["ALLOW", "WARN", "BLOCK"]);

export type SafetyLevel = z.infer<typeof SafetyLevelSchema>;

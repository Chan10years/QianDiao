import { z } from "zod";

import type { Feedback, FeedbackDelta } from "@/src/domain/feedback";

export type AdjustmentDimension = "sweetness" | "acidity" | "alcoholIntensity" | "body";

export type AdjustmentAction =
  | "KEEP"
  | "INCREASE_SWEETENER"
  | "REDUCE_SWEETENER"
  | "INCREASE_ACID_COMPONENT"
  | "REDUCE_ACID_COMPONENT"
  | "INCREASE_SPIRIT_VOLUME"
  | "REDUCE_SPIRIT_VOLUME"
  | "INCREASE_DILUTION"
  | "INCREASE_BODY_SUPPORT"
  | "REDUCE_BODY_SUPPORT";

export interface AdjustmentConstraint {
  dimension: AdjustmentDimension;
  delta: FeedbackDelta;
  actions: readonly AdjustmentAction[];
  magnitude: 0 | 1 | 2;
}

export interface AdjustmentConstraints {
  constraints: readonly AdjustmentConstraint[];
}

const AdjustmentActionSchema = z.enum([
  "KEEP",
  "INCREASE_SWEETENER",
  "REDUCE_SWEETENER",
  "INCREASE_ACID_COMPONENT",
  "REDUCE_ACID_COMPONENT",
  "INCREASE_SPIRIT_VOLUME",
  "REDUCE_SPIRIT_VOLUME",
  "INCREASE_DILUTION",
  "INCREASE_BODY_SUPPORT",
  "REDUCE_BODY_SUPPORT",
]);

export const AdjustmentConstraintsSchema = z
  .object({
    constraints: z
      .array(
        z
          .object({
            dimension: z.enum(["sweetness", "acidity", "alcoholIntensity", "body"]),
            delta: z.union([
              z.literal(-2),
              z.literal(-1),
              z.literal(0),
              z.literal(1),
              z.literal(2),
            ]),
            actions: z.array(AdjustmentActionSchema).min(1).readonly(),
            magnitude: z.union([z.literal(0), z.literal(1), z.literal(2)]),
          })
          .strict(),
      )
      .readonly(),
  })
  .strict();

const adjustmentDimensions: readonly AdjustmentDimension[] = [
  "sweetness",
  "acidity",
  "alcoholIntensity",
  "body",
];

function actionsFor(
  dimension: AdjustmentDimension,
  delta: FeedbackDelta,
): readonly AdjustmentAction[] {
  if (delta === 0) {
    return ["KEEP"];
  }

  if (dimension === "sweetness") {
    return [delta < 0 ? "REDUCE_SWEETENER" : "INCREASE_SWEETENER"];
  }
  if (dimension === "acidity") {
    return [delta < 0 ? "REDUCE_ACID_COMPONENT" : "INCREASE_ACID_COMPONENT"];
  }
  if (dimension === "body") {
    return [delta < 0 ? "REDUCE_BODY_SUPPORT" : "INCREASE_BODY_SUPPORT"];
  }
  if (delta === -2) {
    return ["REDUCE_SPIRIT_VOLUME", "INCREASE_DILUTION"];
  }
  return [delta < 0 ? "REDUCE_SPIRIT_VOLUME" : "INCREASE_SPIRIT_VOLUME"];
}

export function buildAdjustmentConstraints(feedback: Feedback): AdjustmentConstraints {
  return {
    constraints: adjustmentDimensions.map((dimension) => {
      const delta = feedback.deltas[dimension];
      return {
        dimension,
        delta,
        actions: actionsFor(dimension, delta),
        magnitude: Math.abs(delta) as 0 | 1 | 2,
      };
    }),
  };
}

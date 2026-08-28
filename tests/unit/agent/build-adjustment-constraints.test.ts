import { describe, expect, it } from "vitest";

import type { Feedback } from "@/src/domain/feedback";
import { buildAdjustmentConstraints } from "@/src/agent/build-adjustment-constraints";

function feedbackWithDeltas(deltas: Feedback["deltas"]): Feedback {
  return {
    rating: 3,
    accepted: false,
    deltas,
    notes: "希望下一版更平衡。",
    finalImageId: null,
  };
}

describe("buildAdjustmentConstraints", () => {
  it("expresses every delta for every adjustment dimension with stable actions", () => {
    const expectations = [
      {
        dimension: "sweetness" as const,
        actionForNegative: "REDUCE_SWEETENER" as const,
        actionForPositive: "INCREASE_SWEETENER" as const,
      },
      {
        dimension: "acidity" as const,
        actionForNegative: "REDUCE_ACID_COMPONENT" as const,
        actionForPositive: "INCREASE_ACID_COMPONENT" as const,
      },
      {
        dimension: "alcoholIntensity" as const,
        actionForNegative: "REDUCE_SPIRIT_VOLUME" as const,
        actionForPositive: "INCREASE_SPIRIT_VOLUME" as const,
      },
      {
        dimension: "body" as const,
        actionForNegative: "REDUCE_BODY_SUPPORT" as const,
        actionForPositive: "INCREASE_BODY_SUPPORT" as const,
      },
    ];

    for (const expectation of expectations) {
      for (const delta of [-2, -1, 0, 1, 2] as const) {
        const constraints = buildAdjustmentConstraints(
          feedbackWithDeltas({
            sweetness: expectation.dimension === "sweetness" ? delta : 0,
            acidity: expectation.dimension === "acidity" ? delta : 0,
            alcoholIntensity: expectation.dimension === "alcoholIntensity" ? delta : 0,
            body: expectation.dimension === "body" ? delta : 0,
          }),
        ).constraints;
        const constraint = constraints.find(
          (candidate) => candidate.dimension === expectation.dimension,
        );

        expect(constraint).toEqual({
          dimension: expectation.dimension,
          delta,
          actions:
            delta === 0
              ? ["KEEP"]
              : expectation.dimension === "alcoholIntensity" && delta === -2
                ? ["REDUCE_SPIRIT_VOLUME", "INCREASE_DILUTION"]
                : [delta < 0 ? expectation.actionForNegative : expectation.actionForPositive],
          magnitude: Math.abs(delta) as 0 | 1 | 2,
        });
      }
    }
  });

  it("turns alcohol intensity minus two into a structural dilution action", () => {
    const result = buildAdjustmentConstraints(
      feedbackWithDeltas({
        sweetness: 0,
        acidity: 0,
        alcoholIntensity: -2,
        body: 0,
      }),
    );

    const alcoholConstraint = result.constraints.find(
      (constraint) => constraint.dimension === "alcoholIntensity",
    );

    expect(alcoholConstraint).toEqual({
      dimension: "alcoholIntensity",
      delta: -2,
      actions: ["REDUCE_SPIRIT_VOLUME", "INCREASE_DILUTION"],
      magnitude: 2,
    });
  });
});

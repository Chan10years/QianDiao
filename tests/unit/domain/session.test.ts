import { describe, expect, it } from "vitest";

import { SessionStateSchema } from "@/src/domain/session";

describe("SessionStateSchema", () => {
  it("accepts every state frozen by the product specification", () => {
    const states = [
      "PREFERENCES",
      "SCAN",
      "CONFIRM",
      "READY",
      "RECIPE_SELECTION",
      "MIXING",
      "FEEDBACK",
      "ADJUSTMENT",
      "COMPLETED",
    ];

    expect(states.every((state) => SessionStateSchema.safeParse(state).success)).toBe(true);
  });

  it("rejects an unknown state", () => {
    expect(SessionStateSchema.safeParse("PAUSED").success).toBe(false);
  });

  it("rejects an empty or non-string state", () => {
    expect(SessionStateSchema.safeParse("").success).toBe(false);
    expect(SessionStateSchema.safeParse(null).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { DetectedIngredientSchema } from "@/src/domain/ingredient";

describe("DetectedIngredientSchema", () => {
  it("allows an unconfirmed spirit with unknown ABV", () => {
    const fixture = makeDomainFixtures();

    expect(DetectedIngredientSchema.parse(fixture.ingredient)).toMatchObject({
      category: "spirit",
      abv: null,
      confirmed: false,
    });
  });

  it("preserves a confirmed spirit ABV as a separate fact", () => {
    const fixture = makeDomainFixtures();

    const result = DetectedIngredientSchema.parse({
      ...fixture.ingredient,
      brand: "示例白酒",
      abv: 42,
      confidence: 1,
      confirmed: true,
    });

    expect(result).toMatchObject({ brand: "示例白酒", abv: 42, confirmed: true });
  });

  it("rejects an empty raw name", () => {
    const fixture = makeDomainFixtures();

    expect(() => DetectedIngredientSchema.parse({ ...fixture.ingredient, rawName: "" })).toThrow();
  });

  it("rejects confidence outside zero to one", () => {
    const fixture = makeDomainFixtures();

    expect(() =>
      DetectedIngredientSchema.parse({ ...fixture.ingredient, confidence: 1.1 }),
    ).toThrow();
    expect(() =>
      DetectedIngredientSchema.parse({ ...fixture.ingredient, confidence: -0.1 }),
    ).toThrow();
  });

  it("rejects a string ABV instead of coercing it", () => {
    const fixture = makeDomainFixtures();

    expect(() => DetectedIngredientSchema.parse({ ...fixture.ingredient, abv: "42" })).toThrow();
  });
});

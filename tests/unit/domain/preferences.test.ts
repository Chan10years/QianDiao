import { describe, expect, it } from "vitest";

import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { TasteProfileSchema } from "@/src/domain/preferences";

describe("TasteProfileSchema", () => {
  it("accepts a complete five-level taste profile", () => {
    const fixture = makeDomainFixtures();

    expect(TasteProfileSchema.parse(fixture.tasteProfile)).toEqual(fixture.tasteProfile);
  });

  it("rejects a taste level below one", () => {
    const fixture = makeDomainFixtures();

    expect(() => TasteProfileSchema.parse({ ...fixture.tasteProfile, sweetness: 0 })).toThrow();
  });

  it("rejects a taste level above five", () => {
    const fixture = makeDomainFixtures();

    expect(() => TasteProfileSchema.parse({ ...fixture.tasteProfile, body: 6 })).toThrow();
  });

  it("rejects numeric strings instead of coercing them", () => {
    const fixture = makeDomainFixtures();

    expect(() => TasteProfileSchema.parse({ ...fixture.tasteProfile, acidity: "3" })).toThrow();
  });
});

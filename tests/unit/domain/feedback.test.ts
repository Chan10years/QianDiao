import { describe, expect, it } from "vitest";

import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { FeedbackSchema } from "@/src/domain/feedback";

describe("FeedbackSchema", () => {
  it("accepts rating, acceptance, four deltas, notes, and an optional final image", () => {
    const fixture = makeDomainFixtures();

    expect(FeedbackSchema.parse(fixture.feedback)).toEqual(fixture.feedback);
  });

  it("rejects ratings outside one to five", () => {
    const fixture = makeDomainFixtures();

    expect(() => FeedbackSchema.parse({ ...fixture.feedback, rating: 0 })).toThrow();
    expect(() => FeedbackSchema.parse({ ...fixture.feedback, rating: 6 })).toThrow();
  });

  it("rejects deltas outside negative two to positive two", () => {
    const fixture = makeDomainFixtures();

    expect(() =>
      FeedbackSchema.parse({
        ...fixture.feedback,
        deltas: { ...fixture.feedback.deltas, body: 3 },
      }),
    ).toThrow();
  });

  it("rejects notes longer than the domain limit", () => {
    const fixture = makeDomainFixtures();

    expect(() => FeedbackSchema.parse({ ...fixture.feedback, notes: "x".repeat(2001) })).toThrow();
  });

  it("rejects a non-UUID final image ID", () => {
    const fixture = makeDomainFixtures();

    expect(() => FeedbackSchema.parse({ ...fixture.feedback, finalImageId: "image-1" })).toThrow();
  });
});

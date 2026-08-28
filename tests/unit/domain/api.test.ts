import { describe, expect, it } from "vitest";

import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { TasteProfileSchema } from "@/src/domain/preferences";
import { ErrorEnvelopeSchema, MutationMetaSchema, SuccessEnvelopeSchema } from "@/src/domain/api";

describe("shared API schemas", () => {
  it("accepts a typed success envelope", () => {
    const fixture = makeDomainFixtures();
    const schema = SuccessEnvelopeSchema(TasteProfileSchema);

    expect(schema.parse(fixture.successEnvelope)).toEqual(fixture.successEnvelope);
  });

  it("rejects a success envelope with a negative session version", () => {
    const fixture = makeDomainFixtures();
    const schema = SuccessEnvelopeSchema(TasteProfileSchema);

    expect(() =>
      schema.parse({
        ...fixture.successEnvelope,
        session: { ...fixture.successEnvelope.session, version: -1 },
      }),
    ).toThrow();
  });

  it("accepts a stable error code and localized message", () => {
    const fixture = makeDomainFixtures();

    expect(ErrorEnvelopeSchema.parse(fixture.errorEnvelope)).toEqual(fixture.errorEnvelope);
  });

  it("rejects unknown error codes", () => {
    const fixture = makeDomainFixtures();

    expect(() =>
      ErrorEnvelopeSchema.parse({
        ...fixture.errorEnvelope,
        error: { ...fixture.errorEnvelope.error, code: "SOMETHING_NEW" },
      }),
    ).toThrow();
  });

  it("rejects malformed field errors", () => {
    const fixture = makeDomainFixtures();

    expect(() =>
      ErrorEnvelopeSchema.parse({
        ...fixture.errorEnvelope,
        error: { ...fixture.errorEnvelope.error, fieldErrors: { sweetness: "too high" } },
      }),
    ).toThrow();
  });

  it("requires a UUID request ID and a non-negative expected version", () => {
    const fixture = makeDomainFixtures();
    const valid = { requestId: fixture.ids.requestId, expectedVersion: 0 };

    expect(MutationMetaSchema.parse(valid)).toEqual(valid);
    expect(() =>
      MutationMetaSchema.parse({ requestId: "request-1", expectedVersion: 0 }),
    ).toThrow();
    expect(() =>
      MutationMetaSchema.parse({ requestId: fixture.ids.requestId, expectedVersion: -1 }),
    ).toThrow();
  });
});

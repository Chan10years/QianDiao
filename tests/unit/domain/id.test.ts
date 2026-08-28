import { describe, expect, it } from "vitest";

import {
  createRecipeId,
  createRequestId,
  createSessionId,
  parseRecipeId,
  parseRequestId,
  parseSessionId,
} from "@/src/domain/id";

describe("branded domain IDs", () => {
  it("generates UUID-backed session, request, and recipe IDs", () => {
    expect(parseSessionId(createSessionId())).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(parseRequestId(createRequestId())).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(parseRecipeId(createRecipeId())).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("rejects non-UUID values at the boundary", () => {
    expect(() => parseSessionId("session-1")).toThrow();
    expect(() => parseRequestId(42)).toThrow();
    expect(() => parseRecipeId("recipe-1")).toThrow();
  });
});

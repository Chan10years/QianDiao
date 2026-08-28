import { describe, expect, it } from "vitest";

describe("getHealthSnapshot", () => {
  it("returns only safe public health fields", async () => {
    const { getHealthSnapshot } = await import("@/src/infrastructure/health/get-health");
    const dependencies = {
      database: "ok" as const,
      uploads: "ok" as const,
      recipeProvider: "fallback",
      visionProvider: "fallback",
      searchProvider: "disabled",
      version: "test-build",
      DATABASE_PATH: "./data/app.db",
      DASHSCOPE_API_KEY: "secret-that-must-not-leak",
    };

    const snapshot = getHealthSnapshot(dependencies);

    expect(Object.keys(snapshot)).toEqual(["status", "checks", "version"]);
    expect(snapshot).toEqual({
      status: "ok",
      checks: {
        database: "ok",
        uploads: "ok",
        recipeProvider: "fallback",
        visionProvider: "fallback",
        searchProvider: "disabled",
      },
      version: "test-build",
    });
    expect(JSON.stringify(snapshot)).not.toContain("DATABASE_PATH");
    expect(JSON.stringify(snapshot)).not.toContain("DASHSCOPE_API_KEY");
    expect(JSON.stringify(snapshot)).not.toContain("secret-that-must-not-leak");
  });

  it("reports a degraded status when a required local check is unavailable", async () => {
    const { getHealthSnapshot } = await import("@/src/infrastructure/health/get-health");

    expect(
      getHealthSnapshot({
        database: "error",
        uploads: "ok",
        recipeProvider: "fallback",
        visionProvider: "fallback",
        searchProvider: "disabled",
        version: "test-build",
      }).status,
    ).toBe("degraded");
  });
});

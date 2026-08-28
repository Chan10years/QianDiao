import { describe, expect, it } from "vitest";

const validFallbackEnv = {
  APP_BASE_URL: "http://127.0.0.1:3000",
  HOSTNAME: "0.0.0.0",
  PORT: "3000",
  DATABASE_PATH: "./data/app.db",
  UPLOAD_DIR: "./data/uploads",
  MAX_UPLOAD_BYTES: "12582912",
  MAX_IMAGE_PIXELS: "40000000",
  IMAGE_LONG_EDGE: "2048",
  AI_MODE: "fallback",
  ENABLE_WEB_SEARCH: "false",
  LOG_LEVEL: "info",
  DATA_RETENTION_DAYS: "7",
};

describe("parseEnv", () => {
  it("rejects a configuration with missing required variables", async () => {
    const { parseEnv } = await import("@/src/config/env");

    expect(() => parseEnv({ AI_MODE: "fallback" })).toThrow(/APP_BASE_URL/);
  });

  it("allows fallback mode without a model API key", async () => {
    const { parseEnv } = await import("@/src/config/env");

    expect(parseEnv(validFallbackEnv).AI_MODE).toBe("fallback");
  });

  it("requires model credentials in qwen mode", async () => {
    const { parseEnv } = await import("@/src/config/env");

    expect(() =>
      parseEnv({
        ...validFallbackEnv,
        AI_MODE: "qwen",
      }),
    ).toThrow(/DASHSCOPE_API_KEY/);
  });
});

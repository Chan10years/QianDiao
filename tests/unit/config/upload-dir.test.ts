import path from "node:path";

import { describe, expect, it } from "vitest";

import { EnvironmentConfigError, parseEnv } from "@/src/config/env";

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

describe("UPLOAD_DIR configuration boundary", () => {
  it("accepts relative and absolute directories outside public", () => {
    expect(parseEnv(validFallbackEnv).UPLOAD_DIR).toBe("./data/uploads");

    const absoluteOutsidePublic = path.join(process.cwd(), "publicity", "uploads");
    expect(parseEnv({ ...validFallbackEnv, UPLOAD_DIR: absoluteOutsidePublic }).UPLOAD_DIR).toBe(
      absoluteOutsidePublic,
    );
  });

  it.each(["./public/uploads", path.join(process.cwd(), "public", "uploads")])(
    "rejects a directory inside public: %s",
    (uploadDirectory) => {
      try {
        parseEnv({ ...validFallbackEnv, UPLOAD_DIR: uploadDirectory });
        throw new Error("expected UPLOAD_DIR to be rejected");
      } catch (error) {
        expect(error).toBeInstanceOf(EnvironmentConfigError);
        expect(error).toMatchObject({ variableNames: ["UPLOAD_DIR"] });
      }
    },
  );
});

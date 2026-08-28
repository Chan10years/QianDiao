import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { EnvironmentConfigError, parseEnv } from "@/src/config/env";

const baseEnvironment = {
  APP_BASE_URL: "http://127.0.0.1:3000",
  HOSTNAME: "0.0.0.0",
  PORT: "3000",
  DATABASE_PATH: "./data/app.db",
  UPLOAD_DIR: "./uploads",
  MAX_UPLOAD_BYTES: "12582912",
  MAX_IMAGE_PIXELS: "40000000",
  IMAGE_LONG_EDGE: "2048",
  AI_MODE: "fallback",
  ENABLE_WEB_SEARCH: "false",
  LOG_LEVEL: "info",
  DATA_RETENTION_DAYS: "7",
};

function isLinkPermissionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;

  return ["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(String(error.code));
}

function assertUploadDirRejected(uploadDirectory: string): void {
  expect(() => parseEnv({ ...baseEnvironment, UPLOAD_DIR: uploadDirectory })).toThrow(
    EnvironmentConfigError,
  );
}

describe.sequential("UPLOAD_DIR physical path boundary", () => {
  it("rejects a real directory symlink that resolves inside public", ({ skip }) => {
    const root = mkdtempSync(path.join(tmpdir(), "baijiu-upload-dir-symlink-"));
    const previousDirectory = process.cwd();
    const publicTarget = path.join(root, "public", "target");
    const uploadLink = path.join(root, "uploads-link");

    try {
      mkdirSync(publicTarget, { recursive: true });
      try {
        symlinkSync(publicTarget, uploadLink, "dir");
      } catch (error) {
        if (isLinkPermissionError(error)) {
          skip(`directory symlink unavailable: ${String(error)}`);
          return;
        }
        throw error;
      }

      process.chdir(root);
      assertUploadDirRejected("./uploads-link");
    } finally {
      process.chdir(previousDirectory);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a real Windows junction that resolves inside public", ({ skip }) => {
    if (process.platform !== "win32") {
      skip("Windows junctions are not available on this platform");
      return;
    }

    const root = mkdtempSync(path.join(tmpdir(), "baijiu-upload-dir-junction-"));
    const previousDirectory = process.cwd();
    const publicTarget = path.join(root, "public", "target");
    const uploadLink = path.join(root, "uploads-junction");

    try {
      mkdirSync(publicTarget, { recursive: true });
      try {
        symlinkSync(publicTarget, uploadLink, "junction");
      } catch (error) {
        if (isLinkPermissionError(error)) {
          skip(`directory junction unavailable: ${String(error)}`);
          return;
        }
        throw error;
      }

      process.chdir(root);
      assertUploadDirRejected("./uploads-junction");
    } finally {
      process.chdir(previousDirectory);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a missing child below a real directory outside public", ({ skip }) => {
    const root = mkdtempSync(path.join(tmpdir(), "baijiu-upload-dir-missing-"));
    const previousDirectory = process.cwd();
    const outsideTarget = path.join(root, "private-target");
    const uploadLink = path.join(root, "uploads-link");

    try {
      mkdirSync(outsideTarget, { recursive: true });
      try {
        symlinkSync(outsideTarget, uploadLink, "dir");
      } catch (error) {
        if (isLinkPermissionError(error)) {
          skip(`directory symlink unavailable: ${String(error)}`);
          return;
        }
        throw error;
      }

      process.chdir(root);
      expect(
        parseEnv({ ...baseEnvironment, UPLOAD_DIR: "./uploads-link/new-dir" }).UPLOAD_DIR,
      ).toBe("./uploads-link/new-dir");
    } finally {
      process.chdir(previousDirectory);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

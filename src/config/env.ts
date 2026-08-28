import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

const positiveIntegerString = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().positive());

const booleanString = z.enum(["true", "false"]).transform((value) => value === "true");

const commonEnvironment = {
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_BASE_URL: z.string().url(),
  HOSTNAME: nonEmptyString,
  PORT: positiveIntegerString.pipe(z.number().max(65535)),
  DATABASE_PATH: nonEmptyString,
  UPLOAD_DIR: nonEmptyString,
  MAX_UPLOAD_BYTES: positiveIntegerString,
  MAX_IMAGE_PIXELS: positiveIntegerString,
  IMAGE_LONG_EDGE: positiveIntegerString,
  ENABLE_WEB_SEARCH: booleanString,
  SEARCH_TIMEOUT_MS: positiveIntegerString.default(2500),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]),
  DATA_RETENTION_DAYS: positiveIntegerString,
};

const fallbackEnvironmentSchema = z.object({
  ...commonEnvironment,
  AI_MODE: z.literal("fallback"),
  DASHSCOPE_API_KEY: nonEmptyString.optional(),
  QWEN_BASE_URL: z.string().url().optional(),
  QWEN_RECIPE_MODEL: nonEmptyString.optional(),
  QWEN_VISION_MODEL: nonEmptyString.optional(),
});

const qwenEnvironmentSchema = z.object({
  ...commonEnvironment,
  AI_MODE: z.literal("qwen"),
  DASHSCOPE_API_KEY: nonEmptyString,
  QWEN_BASE_URL: z.string().url(),
  QWEN_RECIPE_MODEL: nonEmptyString,
  QWEN_VISION_MODEL: nonEmptyString,
});

export const EnvironmentSchema = z.discriminatedUnion("AI_MODE", [
  fallbackEnvironmentSchema,
  qwenEnvironmentSchema,
]);

export type AppEnvironment = z.infer<typeof EnvironmentSchema>;

export class EnvironmentConfigError extends Error {
  readonly variableNames: readonly string[];

  constructor(variableNames: readonly string[]) {
    const uniqueNames = [...new Set(variableNames)].sort();
    super(`Invalid environment configuration: ${uniqueNames.join(", ")}`);
    this.name = "EnvironmentConfigError";
    this.variableNames = uniqueNames;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function resolvePhysicalPath(target: string): string {
  const missingSegments: string[] = [];
  let current = path.resolve(target);

  while (true) {
    try {
      lstatSync(current);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw new EnvironmentConfigError(["UPLOAD_DIR"]);
      }

      const parent = path.dirname(current);
      if (parent === current) {
        throw new EnvironmentConfigError(["UPLOAD_DIR"]);
      }
      missingSegments.unshift(path.basename(current));
      current = parent;
      continue;
    }

    let physicalPath: string;
    try {
      physicalPath = realpathSync.native(current);
    } catch {
      throw new EnvironmentConfigError(["UPLOAD_DIR"]);
    }

    return path.resolve(physicalPath, ...missingSegments);
  }
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const relativePath = path.relative(directory, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

export function parseEnv(input: Record<string, unknown> = process.env): AppEnvironment {
  const result = EnvironmentSchema.safeParse(input);

  if (result.success) {
    const publicDirectory = resolvePhysicalPath(path.resolve(process.cwd(), "public"));
    const uploadDirectory = resolvePhysicalPath(
      path.resolve(process.cwd(), result.data.UPLOAD_DIR),
    );

    if (isWithinDirectory(publicDirectory, uploadDirectory)) {
      throw new EnvironmentConfigError(["UPLOAD_DIR"]);
    }

    return result.data;
  }

  const variableNames = result.error.issues.map((issue) => String(issue.path[0] ?? "AI_MODE"));
  throw new EnvironmentConfigError(variableNames);
}

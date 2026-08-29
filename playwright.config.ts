import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

const runtimeDirectory = mkdtempSync(path.join(tmpdir(), "qiandiao-e2e-"));
const databasePath = path.join(runtimeDirectory, "app.db");
const uploadDirectory = path.join(runtimeDirectory, "uploads");
const port = 3187;
const baseURL = `http://127.0.0.1:${port}`;

function cleanupRuntimeDirectory(): void {
  rmSync(runtimeDirectory, { recursive: true, force: true });
}

process.once("exit", cleanupRuntimeDirectory);

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "html",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 5"] },
    },
  ],
  webServer: {
    command: `pnpm db:migrate && pnpm db:seed && pnpm dev --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    env: {
      APP_BASE_URL: baseURL,
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      DATABASE_PATH: databasePath,
      UPLOAD_DIR: uploadDirectory,
      MAX_UPLOAD_BYTES: "12582912",
      MAX_IMAGE_PIXELS: "40000000",
      IMAGE_LONG_EDGE: "2048",
      AI_MODE: "fallback",
      ENABLE_WEB_SEARCH: "false",
      SEARCH_TIMEOUT_MS: "2500",
      LOG_LEVEL: "error",
      DATA_RETENTION_DAYS: "7",
    },
  },
});

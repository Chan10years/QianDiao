import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createTestDatabase } from "@/tests/helpers/test-database";

const SqliteTableRowSchema = z.object({ name: z.string() }).strict();

describe("SQLite database bootstrap", () => {
  it("creates every required table in an isolated database", () => {
    const database = createTestDatabase();

    try {
      const tables = database.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => SqliteTableRowSchema.parse(row).name);

      expect(tables).toEqual(
        expect.arrayContaining([
          "sessions",
          "images",
          "ingredients",
          "recipe_sets",
          "recipes",
          "safety_decisions",
          "feedback",
          "decision_events",
          "experiment_memories",
          "idempotency_records",
          "session_mutation_leases",
        ]),
      );
      expect(database.databasePath).not.toContain(`${pathSeparator()}data${pathSeparator()}app.db`);
    } finally {
      database.cleanup();
    }
  });

  it("keeps foreign keys enabled and uses a busy timeout and WAL for file databases", () => {
    const database = createTestDatabase();

    try {
      expect(database.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(database.sqlite.pragma("busy_timeout", { simple: true })).toBeGreaterThanOrEqual(5000);
      expect(database.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      database.cleanup();
    }
  });

  it("applies migrations twice and passes SQLite integrity_check in isolation", () => {
    const database = createTestDatabase();

    try {
      expect(() => database.applyMigrations()).not.toThrow();
      expect(database.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      database.cleanup();
    }
  });

  it("persists mixing photo links and accepts the mixing_step image role", () => {
    const database = createTestDatabase();

    try {
      const columns = database.sqlite
        .prepare("PRAGMA table_info(images)")
        .all()
        .map((row) => (row as { name: string }).name);
      const imagesTable = database.sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'images'")
        .get() as { sql: string };

      expect(columns).toEqual(expect.arrayContaining(["recipe_id", "step_index"]));
      expect(imagesTable.sql).toContain("mixing_step");
      expect(() => database.applyMigrations()).not.toThrow();
    } finally {
      database.cleanup();
    }
  });
});

function pathSeparator(): string {
  return "\\";
}

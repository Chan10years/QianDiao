import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "@/src/infrastructure/db/client";

const migrationFiles = [
  "0000_married_mongoose.sql",
  "0001_useful_morlun.sql",
  "0002_flashy_dreaming_celestial.sql",
  "0003_mighty_maverick.sql",
  "0004_oval_eternals.sql",
  "0005_curved_blue_shield.sql",
] as const;

const snapshotFiles = [
  "0000_snapshot.json",
  "0001_snapshot.json",
  "0002_snapshot.json",
  "0003_snapshot.json",
  "0004_snapshot.json",
  "0005_snapshot.json",
] as const;

interface MigrationDatabase {
  database: DatabaseHandle;
  directory: string;
}

interface RecipeColumnRow {
  name: string;
  notnull: number;
}

interface ForeignKeyRow {
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

interface LegacyRecipeRow {
  feedback_id: string | null;
}

function createMigrationDatabase(): MigrationDatabase {
  const directory = mkdtempSync(path.join(tmpdir(), "baijiu-task-13-migration-"));
  return {
    database: createDatabase(path.join(directory, "test.db")),
    directory,
  };
}

function closeMigrationDatabase(context: MigrationDatabase): void {
  context.database.close();
  rmSync(context.directory, { recursive: true, force: true });
}

function createPreTask13MigrationFolder(): { folder: string; cleanup: () => void } {
  const folder = mkdtempSync(path.join(tmpdir(), "baijiu-task-13-old-migrations-"));
  const metaFolder = path.join(folder, "meta");
  mkdirSync(metaFolder);

  for (const file of migrationFiles) {
    cpSync(path.resolve(process.cwd(), "drizzle", file), path.join(folder, file));
  }
  for (const file of snapshotFiles) {
    cpSync(path.resolve(process.cwd(), "drizzle", "meta", file), path.join(metaFolder, file));
  }
  const journal = JSON.parse(
    readFileSync(path.resolve(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
  ) as { version: string; dialect: string; entries: unknown[] };
  writeFileSync(
    path.join(metaFolder, "_journal.json"),
    JSON.stringify(
      { ...journal, entries: journal.entries.slice(0, migrationFiles.length) },
      null,
      2,
    ),
  );

  return {
    folder,
    cleanup: () => rmSync(folder, { recursive: true, force: true }),
  };
}

function seedLegacyRecipe(
  database: DatabaseHandle,
  ids: { sessionId: string; setId: string; recipeId: string },
) {
  database.sqlite
    .prepare(
      "INSERT INTO sessions (id, state, version, created_at, updated_at) VALUES (?, 'PREFERENCES', 0, 0, 0)",
    )
    .run(ids.sessionId);
  database.sqlite
    .prepare(
      "INSERT INTO recipe_sets (id, session_id, source_mode, created_at) VALUES (?, ?, 'fallback', 0)",
    )
    .run(ids.setId, ids.sessionId);
  database.sqlite
    .prepare(
      `INSERT INTO recipes (
        id, session_id, recipe_set_id, strategy, title, fit_reason, difference_reason,
        materials_json, steps_json, estimated_abv, safety_level, experimental,
        missing_ingredients_json, version, parent_recipe_id, created_at
      ) VALUES (?, ?, ?, 'A_CONSERVATIVE', '旧配方', '旧数据可读', '旧数据可读',
        '[{"name":"白酒","amountMl":30,"unit":"ml"}]',
        '[{"order":1,"instruction":"加入并搅拌","isPhotoCheckpoint":false}]',
        12, 'ALLOW', 0, '[]', 1, NULL, 0)`,
    )
    .run(ids.recipeId, ids.sessionId, ids.setId);
}

describe("Task 13 recipe feedback migration", () => {
  it("adds a nullable feedback foreign key and rejects an unknown feedback ID", () => {
    const context = createMigrationDatabase();

    try {
      migrate(context.database.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });

      const columns = context.database.sqlite
        .prepare("PRAGMA table_info(recipes)")
        .all() as RecipeColumnRow[];
      expect(columns.find((column) => column.name === "feedback_id")).toMatchObject({
        name: "feedback_id",
        notnull: 0,
      });

      const foreignKeys = context.database.sqlite
        .prepare("PRAGMA foreign_key_list(recipes)")
        .all() as ForeignKeyRow[];
      expect(foreignKeys).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: "feedback",
            from: "feedback_id",
            to: "id",
            on_delete: "NO ACTION",
          }),
        ]),
      );

      seedLegacyRecipe(context.database, {
        sessionId: "123e4567-e89b-12d3-a456-426614174000",
        setId: "123e4567-e89b-12d3-a456-426614174001",
        recipeId: "123e4567-e89b-12d3-a456-426614174002",
      });

      expect(() =>
        context.database.sqlite
          .prepare("UPDATE recipes SET feedback_id = ? WHERE id = ?")
          .run("123e4567-e89b-12d3-a456-426614174099", "123e4567-e89b-12d3-a456-426614174002"),
      ).toThrow();
    } finally {
      closeMigrationDatabase(context);
    }
  });

  it("upgrades a 0005 database without changing old rows and remains safe to rerun", () => {
    const context = createMigrationDatabase();
    const oldMigrations = createPreTask13MigrationFolder();
    const ids = {
      sessionId: "223e4567-e89b-12d3-a456-426614174000",
      setId: "223e4567-e89b-12d3-a456-426614174001",
      recipeId: "223e4567-e89b-12d3-a456-426614174002",
    };

    try {
      migrate(context.database.db, { migrationsFolder: oldMigrations.folder });
      seedLegacyRecipe(context.database, ids);

      migrate(context.database.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });

      const oldRow = context.database.sqlite
        .prepare("SELECT feedback_id FROM recipes WHERE id = ?")
        .get(ids.recipeId) as LegacyRecipeRow;
      expect(oldRow.feedback_id).toBeNull();

      expect(() =>
        migrate(context.database.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") }),
      ).not.toThrow();
      expect(context.database.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      closeMigrationDatabase(context);
      oldMigrations.cleanup();
    }
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import { createDatabase, type DatabaseHandle } from "@/src/infrastructure/db/client";

export interface TestDatabase extends DatabaseHandle {
  databasePath: string;
  cleanup: () => void;
}

export function createTestDatabase(): TestDatabase {
  const directory = mkdtempSync(path.join(tmpdir(), "baijiu-repository-test-"));
  const databasePath = path.join(directory, "test.db");
  const handle = createDatabase(databasePath);

  migrate(handle.db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });

  return {
    ...handle,
    databasePath,
    cleanup: () => {
      handle.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

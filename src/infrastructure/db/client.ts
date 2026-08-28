import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import path from "node:path";

import { schema } from "@/src/infrastructure/db/schema";

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  db: AppDatabase;
  sqlite: Database.Database;
  applyMigrations: (migrationsFolder?: string) => void;
  close: () => void;
}

export function createDatabase(databasePath: string): DatabaseHandle {
  const sqlite = new Database(databasePath);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");

  const db = drizzle(sqlite, { schema });

  return {
    db,
    sqlite,
    applyMigrations: (migrationsFolder = path.resolve(process.cwd(), "drizzle")) => {
      migrate(db, { migrationsFolder });
    },
    close: () => sqlite.close(),
  };
}

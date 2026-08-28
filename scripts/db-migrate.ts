import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { createDatabase } from "@/src/infrastructure/db/client";

export function migrateDatabase(databasePath: string): void {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = createDatabase(databasePath);
  try {
    database.applyMigrations();
  } finally {
    database.close();
  }
}

const invokedScript = process.argv[1];
if (invokedScript !== undefined && import.meta.url === pathToFileURL(invokedScript).href) {
  migrateDatabase(path.resolve(process.env.DATABASE_PATH ?? "./data/app.db"));
  console.log("Database migrations applied.");
}

import type { BetterSQLiteTransaction } from "drizzle-orm/better-sqlite3";
import type { ExtractTablesWithRelations } from "drizzle-orm";

import type { AppDatabase } from "@/src/infrastructure/db/client";
import { schema } from "@/src/infrastructure/db/schema";

export type TransactionDatabase = BetterSQLiteTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
export type DatabaseExecutor = AppDatabase | TransactionDatabase;

export function withTransaction<T>(
  database: AppDatabase,
  operation: (transaction: TransactionDatabase) => T,
): T {
  return database.transaction(operation);
}

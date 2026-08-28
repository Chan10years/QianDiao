export type LocalHealthStatus = "ok" | "error";

export interface HealthDependencies {
  database: LocalHealthStatus;
  uploads: LocalHealthStatus;
  recipeProvider: string;
  visionProvider: string;
  searchProvider: string;
  version: string;
}

export interface HealthSnapshot {
  status: "ok" | "degraded";
  checks: {
    database: LocalHealthStatus;
    uploads: LocalHealthStatus;
    recipeProvider: string;
    visionProvider: string;
    searchProvider: string;
  };
  version: string;
}

export function getHealthSnapshot(dependencies: HealthDependencies): HealthSnapshot {
  const { database, uploads, recipeProvider, visionProvider, searchProvider, version } =
    dependencies;

  return {
    status: database === "ok" && uploads === "ok" ? "ok" : "degraded",
    checks: {
      database,
      uploads,
      recipeProvider,
      visionProvider,
      searchProvider,
    },
    version,
  };
}

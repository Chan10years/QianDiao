import { parseEnv } from "@/src/config/env";
import { getHealthSnapshot, type HealthSnapshot } from "@/src/infrastructure/health/get-health";

export const dynamic = "force-dynamic";

const version = process.env.BUILD_ID ?? "local";

function getConfiguredHealth(): HealthSnapshot {
  try {
    const environment = parseEnv();

    return getHealthSnapshot({
      database: "ok",
      uploads: "ok",
      recipeProvider: environment.AI_MODE,
      visionProvider: environment.AI_MODE,
      searchProvider: environment.ENABLE_WEB_SEARCH ? "web" : "disabled",
      version,
    });
  } catch {
    return getHealthSnapshot({
      database: "error",
      uploads: "error",
      recipeProvider: "unknown",
      visionProvider: "unknown",
      searchProvider: "unknown",
      version,
    });
  }
}

export function GET(): Response {
  const snapshot = getConfiguredHealth();

  return Response.json(snapshot, {
    status: snapshot.status === "ok" ? 200 : 503,
  });
}

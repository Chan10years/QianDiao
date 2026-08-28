import { z } from "zod";

import {
  generateRecipeSet,
  RecipeGenerationBlockedError,
  RecipeProviderUnavailableError,
  type GenerateRecipeSetDependencies,
} from "@/src/application/generate-recipe-set";
import {
  getRecipeSet,
  RecipeSetInvariantError,
  RecipeSetNotFoundError,
} from "@/src/application/get-recipe-set";
import { createDefaultGenerateRecipeSetDependencies } from "@/src/infrastructure/routes/recipe-route-dependencies";
import { errorResponse, mapSessionError, readJson } from "@/src/infrastructure/http/envelopes";

const JsonObjectSchema = z.record(z.string(), z.unknown());

export interface RecipeRouteContext {
  params: Promise<{ sessionId: string }>;
}

function mapRecipeRouteError(error: unknown): Response {
  if (error instanceof RecipeGenerationBlockedError) {
    return errorResponse("INVALID_REQUEST", "当前材料未通过安全预检，无法生成配方", 422);
  }
  if (error instanceof RecipeProviderUnavailableError) {
    return errorResponse(
      "PROVIDER_UNAVAILABLE",
      "配方生成服务暂时不可用，已无法继续降级",
      503,
      true,
    );
  }
  if (error instanceof RecipeSetNotFoundError) {
    return errorResponse("NOT_FOUND", "当前会话尚未生成配方", 404);
  }
  if (error instanceof RecipeSetInvariantError) {
    return errorResponse("INVALID_STATE", "当前配方集状态不一致，请重新生成", 409);
  }
  return mapSessionError(error);
}

export function createRecipeGenerationRouteHandlers(
  dependencies: GenerateRecipeSetDependencies = createDefaultGenerateRecipeSetDependencies(),
) {
  return {
    async GET(_request: Request, context: RecipeRouteContext): Promise<Response> {
      try {
        const { sessionId } = await context.params;
        return Response.json(getRecipeSet(dependencies, { sessionId }), { status: 200 });
      } catch (error) {
        return mapRecipeRouteError(error);
      }
    },

    async POST(request: Request, context: RecipeRouteContext): Promise<Response> {
      try {
        const { sessionId } = await context.params;
        const body = JsonObjectSchema.parse(await readJson(request));
        const result = await generateRecipeSet(dependencies, { ...body, sessionId });
        return Response.json(result.response, { status: 201 });
      } catch (error) {
        return mapRecipeRouteError(error);
      }
    },
  };
}

export async function GET(request: Request, context: RecipeRouteContext): Promise<Response> {
  return createRecipeGenerationRouteHandlers().GET(request, context);
}

export async function POST(request: Request, context: RecipeRouteContext): Promise<Response> {
  return createRecipeGenerationRouteHandlers().POST(request, context);
}

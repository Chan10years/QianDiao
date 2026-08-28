import {
  RecipeCandidateSetSchema,
  type RecipeCandidate,
  type RecipeCandidateSet,
} from "@/src/domain/recipe";
import {
  type OutcomeAwareRecipeProvider,
  RecipeAdjustmentInputSchema,
  RecipeGenerationInputSchema,
  type RecipeProviderOutcome,
  type RecipeProviderCallOptions,
  type RecipeProvenanceStage,
  type QwenCompletionClient,
  type QwenCompletionRequest,
  type RecipeAdjustmentInput,
  type RecipeGenerationInput,
  type RecipeProvider,
} from "@/src/providers/recipe-provider";
import {
  buildAdjustRecipePrompt,
  buildGenerateRecipesPrompt,
  buildRepairPrompt,
  RECIPE_CANDIDATE_JSON_SCHEMA,
  RECIPE_CANDIDATE_SET_JSON_SCHEMA,
} from "@/src/agent/prompts/generate-recipes";
import {
  validateAdjustedCandidate,
  validateCandidateSet,
} from "@/src/agent/validate-candidate-set";
import { rankRecommendation } from "@/src/agent/rank-recommendation";
import { FallbackRecipeProvider } from "@/src/infrastructure/providers/fallback-recipe-provider";

export const QWEN_RECIPE_PROVIDER_TIMEOUT_MS = 5_000;
export const QWEN_RECIPE_PROVIDER_MAX_REQUESTS_PER_OPERATION = 2;
export const QWEN_RECIPE_PROVIDER_WORST_CASE_EXTERNAL_CALL_MS =
  QWEN_RECIPE_PROVIDER_TIMEOUT_MS * QWEN_RECIPE_PROVIDER_MAX_REQUESTS_PER_OPERATION;

export interface QwenRecipeProviderOptions {
  client: QwenCompletionClient;
  model: string;
  timeoutMs?: number;
  fallback?: RecipeProvider;
}

function parseJsonResponse(response: string): unknown {
  const trimmed = response.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "")
    : trimmed;
  return JSON.parse(unfenced);
}

function parseCandidateSet(
  response: string,
  allowedMaterialNames: readonly string[],
): RecipeCandidateSet {
  return validateCandidateSet(RecipeCandidateSetSchema.parse(parseJsonResponse(response)), {
    allowedMaterialNames,
  });
}

function confirmedMaterialNames(input: RecipeGenerationInput): readonly string[] {
  return input.ingredients
    .filter((ingredient) => ingredient.confirmed)
    .map((ingredient) => ingredient.canonicalName);
}

function parseCandidate(
  response: string,
  currentRecipe: RecipeCandidate,
  confirmedMaterialNames: readonly string[],
): RecipeCandidate {
  return validateAdjustedCandidate(
    parseJsonResponse(response),
    currentRecipe,
    confirmedMaterialNames,
  );
}

export class QwenRecipeProvider implements OutcomeAwareRecipeProvider {
  private readonly client: QwenCompletionClient;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fallback: RecipeProvider;

  constructor(options: QwenRecipeProviderOptions) {
    this.client = options.client;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? QWEN_RECIPE_PROVIDER_TIMEOUT_MS;
    this.fallback = options.fallback ?? new FallbackRecipeProvider();
  }

  private async request(
    operation: QwenCompletionRequest["operation"],
    prompt: string,
    jsonSchema: unknown,
  ): Promise<string> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const abortController = new AbortController();

    try {
      const completion = this.client.complete({
        operation,
        model: this.model,
        prompt,
        timeoutMs: this.timeoutMs,
        jsonSchema,
        signal: abortController.signal,
      });
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          abortController.abort();
          reject(new Error(`Recipe provider ${operation} timed out`));
        }, this.timeoutMs);
      });
      return await Promise.race([completion, timeout]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  async generateWithOutcome(
    input: RecipeGenerationInput,
    options?: RecipeProviderCallOptions,
  ): Promise<RecipeProviderOutcome<RecipeCandidateSet>> {
    const parsedInput = RecipeGenerationInputSchema.parse(input);
    const prompt = buildGenerateRecipesPrompt(parsedInput);
    const allowedMaterialNames = confirmedMaterialNames(parsedInput);

    let initialResponse: string;
    await options?.beforeExternalCall?.();
    try {
      initialResponse = await this.request("generate", prompt, RECIPE_CANDIDATE_SET_JSON_SCHEMA);
    } catch {
      return {
        value: await this.fallback.generate(parsedInput),
        sourceMode: "fallback",
        degraded: true,
        provenanceStages: [
          {
            phase: "generate",
            attempt: 0,
            sourceMode: "fallback",
            degraded: true,
            outcome: "timeout",
          },
        ],
      };
    }

    try {
      const candidateSet = parseCandidateSet(initialResponse, allowedMaterialNames);
      return {
        value: rankRecommendation({
          preferences: parsedInput.preferences,
          candidateSet,
          allowedMaterialNames,
        }).candidateSet,
        sourceMode: "qwen",
        degraded: false,
        provenanceStages: [
          {
            phase: "generate",
            attempt: 0,
            sourceMode: "qwen",
            degraded: false,
            outcome: "accepted",
          },
        ],
      };
    } catch {
      const invalidOutputStage: RecipeProvenanceStage = {
        phase: "generate",
        attempt: 0,
        sourceMode: "qwen",
        degraded: false,
        outcome: "invalid_output",
      };
      let repairedResponse: string;
      await options?.beforeExternalCall?.();
      try {
        repairedResponse = await this.request(
          "generate",
          buildRepairPrompt("generate", initialResponse),
          RECIPE_CANDIDATE_SET_JSON_SCHEMA,
        );
      } catch {
        return {
          value: await this.fallback.generate(parsedInput),
          sourceMode: "fallback",
          degraded: true,
          provenanceStages: [
            invalidOutputStage,
            {
              phase: "generate",
              attempt: 1,
              sourceMode: "qwen",
              degraded: false,
              outcome: "repair_failed",
            },
            {
              phase: "fallback",
              attempt: 0,
              sourceMode: "fallback",
              degraded: true,
              outcome: "fallback",
            },
          ],
        };
      }

      try {
        const candidateSet = parseCandidateSet(repairedResponse, allowedMaterialNames);
        return {
          value: rankRecommendation({
            preferences: parsedInput.preferences,
            candidateSet,
            allowedMaterialNames,
          }).candidateSet,
          sourceMode: "qwen",
          degraded: false,
          provenanceStages: [
            invalidOutputStage,
            {
              phase: "generate",
              attempt: 1,
              sourceMode: "qwen",
              degraded: false,
              outcome: "repair_accepted",
            },
          ],
        };
      } catch {
        return {
          value: await this.fallback.generate(parsedInput),
          sourceMode: "fallback",
          degraded: true,
          provenanceStages: [
            invalidOutputStage,
            {
              phase: "generate",
              attempt: 1,
              sourceMode: "qwen",
              degraded: false,
              outcome: "repair_failed",
            },
            {
              phase: "fallback",
              attempt: 0,
              sourceMode: "fallback",
              degraded: true,
              outcome: "fallback",
            },
          ],
        };
      }
    }
  }

  async generate(input: RecipeGenerationInput): Promise<RecipeCandidateSet> {
    return (await this.generateWithOutcome(input)).value;
  }

  async adjustWithOutcome(
    input: RecipeAdjustmentInput,
    options?: RecipeProviderCallOptions,
  ): Promise<RecipeProviderOutcome<RecipeCandidate>> {
    const parsedInput = RecipeAdjustmentInputSchema.parse(input);
    const prompt = buildAdjustRecipePrompt(parsedInput);

    let initialResponse: string;
    await options?.beforeExternalCall?.();
    try {
      initialResponse = await this.request("adjust", prompt, RECIPE_CANDIDATE_JSON_SCHEMA);
    } catch {
      return {
        value: await this.fallback.adjust(parsedInput),
        sourceMode: "fallback",
        degraded: true,
        provenanceStages: [
          {
            phase: "fallback",
            attempt: 0,
            sourceMode: "fallback",
            degraded: true,
            outcome: "timeout",
          },
        ],
      };
    }

    try {
      return {
        value: parseCandidate(
          initialResponse,
          parsedInput.currentRecipe,
          parsedInput.confirmedMaterialNames,
        ),
        sourceMode: "qwen",
        degraded: false,
        provenanceStages: [
          {
            phase: "repair",
            attempt: 0,
            sourceMode: "qwen",
            degraded: false,
            outcome: "accepted",
          },
        ],
      };
    } catch {
      const invalidOutputStage: RecipeProvenanceStage = {
        phase: "repair",
        attempt: 0,
        sourceMode: "qwen",
        degraded: false,
        outcome: "invalid_output",
      };
      let repairedResponse: string;
      await options?.beforeExternalCall?.();
      try {
        repairedResponse = await this.request(
          "adjust",
          buildRepairPrompt("adjust", initialResponse),
          RECIPE_CANDIDATE_JSON_SCHEMA,
        );
      } catch {
        return {
          value: await this.fallback.adjust(parsedInput),
          sourceMode: "fallback",
          degraded: true,
          provenanceStages: [
            invalidOutputStage,
            {
              phase: "repair",
              attempt: 1,
              sourceMode: "qwen",
              degraded: false,
              outcome: "repair_failed",
            },
            {
              phase: "fallback",
              attempt: 0,
              sourceMode: "fallback",
              degraded: true,
              outcome: "fallback",
            },
          ],
        };
      }

      try {
        return {
          value: parseCandidate(
            repairedResponse,
            parsedInput.currentRecipe,
            parsedInput.confirmedMaterialNames,
          ),
          sourceMode: "qwen",
          degraded: false,
          provenanceStages: [
            invalidOutputStage,
            {
              phase: "repair",
              attempt: 1,
              sourceMode: "qwen",
              degraded: false,
              outcome: "repair_accepted",
            },
          ],
        };
      } catch {
        return {
          value: await this.fallback.adjust(parsedInput),
          sourceMode: "fallback",
          degraded: true,
          provenanceStages: [
            invalidOutputStage,
            {
              phase: "repair",
              attempt: 1,
              sourceMode: "qwen",
              degraded: false,
              outcome: "repair_failed",
            },
            {
              phase: "fallback",
              attempt: 0,
              sourceMode: "fallback",
              degraded: true,
              outcome: "fallback",
            },
          ],
        };
      }
    }
  }

  async adjust(input: RecipeAdjustmentInput): Promise<RecipeCandidate> {
    return (await this.adjustWithOutcome(input)).value;
  }
}

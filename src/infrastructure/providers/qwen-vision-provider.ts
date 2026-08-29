import {
  normalizeVisionResult,
  VisionInputSchema,
  VisionResultSchema,
  type QwenVisionCompletionClient,
  type QwenVisionCompletionRequest,
  type VisionInput,
  type VisionImageContent,
  type VisionImageLoader,
  type VisionProvider,
  type VisionResult,
} from "@/src/providers/vision-provider";
import {
  buildRecognizeIngredientsPrompt,
  buildRepairVisionPrompt,
  VISION_RESULT_JSON_SCHEMA,
} from "@/src/agent/prompts/recognize-ingredients";
import { FallbackVisionProvider } from "@/src/infrastructure/providers/fallback-vision-provider";

export interface QwenVisionProviderOptions {
  client: QwenVisionCompletionClient;
  model: string;
  timeoutMs?: number;
  fallback?: VisionProvider;
  imageLoader: VisionImageLoader;
}

export const QWEN_VISION_PROVIDER_TIMEOUT_MS = 60_000;

function parseJsonResponse(response: string): unknown {
  const trimmed = response.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "")
    : trimmed;
  return JSON.parse(unfenced);
}

function parseVisionResponse(response: string): VisionResult {
  const payload = parseJsonResponse(response);
  const modelObject =
    typeof payload === "object" && payload !== null ? payload : Object.create(null);

  return normalizeVisionResult(
    VisionResultSchema.parse({
      ...modelObject,
      sourceMode: "qwen",
    }),
  );
}

export class QwenVisionProvider implements VisionProvider {
  private readonly client: QwenVisionCompletionClient;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fallback: VisionProvider;
  private readonly imageLoader: VisionImageLoader;

  constructor(options: QwenVisionProviderOptions) {
    this.client = options.client;
    this.model = options.model;
    this.timeoutMs = Math.min(
      options.timeoutMs ?? QWEN_VISION_PROVIDER_TIMEOUT_MS,
      QWEN_VISION_PROVIDER_TIMEOUT_MS,
    );
    this.fallback = options.fallback ?? new FallbackVisionProvider();
    this.imageLoader = options.imageLoader;
  }

  private async request(prompt: string, images: readonly VisionImageContent[]): Promise<string> {
    const request: QwenVisionCompletionRequest = {
      model: this.model,
      prompt,
      timeoutMs: this.timeoutMs,
      jsonSchema: VISION_RESULT_JSON_SCHEMA,
      images,
    };
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      const completion = this.client.complete(request);
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error("Vision provider timed out")),
          this.timeoutMs,
        );
      });
      return await Promise.race([completion, timeout]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  async recognize(input: VisionInput): Promise<VisionResult> {
    const parsedInput = VisionInputSchema.parse(input);
    const prompt = buildRecognizeIngredientsPrompt(parsedInput);
    let initialResponse: string;
    let images: readonly VisionImageContent[] = [];

    try {
      images = await this.imageLoader.load(parsedInput);
      initialResponse = await this.request(prompt, images);
    } catch {
      return this.fallback.recognize(parsedInput);
    }

    try {
      return parseVisionResponse(initialResponse);
    } catch {
      let repairedResponse: string;
      try {
        repairedResponse = await this.request(buildRepairVisionPrompt(initialResponse), images);
      } catch {
        return this.fallback.recognize(parsedInput);
      }

      try {
        return parseVisionResponse(repairedResponse);
      } catch {
        return this.fallback.recognize(parsedInput);
      }
    }
  }
}

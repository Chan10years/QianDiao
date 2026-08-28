import { FallbackVisionProvider } from "@/src/infrastructure/providers/fallback-vision-provider";
import { OpenAIQwenVisionClient } from "@/src/infrastructure/providers/openai-qwen-vision-client";
import { QwenVisionProvider } from "@/src/infrastructure/providers/qwen-vision-provider";
import type {
  QwenVisionCompletionClient,
  VisionImageLoader,
  VisionProvider,
} from "@/src/providers/vision-provider";

export type VisionProviderSelectionConfig =
  | {
      AI_MODE: "fallback";
    }
  | {
      AI_MODE: "qwen";
      DASHSCOPE_API_KEY: string;
      QWEN_BASE_URL: string;
      QWEN_VISION_MODEL: string;
    };

export interface VisionProviderFactoryDependencies {
  qwenClient?: QwenVisionCompletionClient;
  imageLoader?: VisionImageLoader;
}

export function createConfiguredVisionProvider(
  config: VisionProviderSelectionConfig,
  dependencies: VisionProviderFactoryDependencies = {},
): VisionProvider {
  if (config.AI_MODE === "fallback") {
    return new FallbackVisionProvider();
  }

  if (dependencies.imageLoader === undefined) {
    throw new Error("VISION_IMAGE_LOADER_REQUIRED");
  }

  const qwenClient =
    dependencies.qwenClient ??
    new OpenAIQwenVisionClient({
      apiKey: config.DASHSCOPE_API_KEY,
      baseURL: config.QWEN_BASE_URL,
    });

  return new QwenVisionProvider({
    client: qwenClient,
    model: config.QWEN_VISION_MODEL,
    imageLoader: dependencies.imageLoader,
  });
}

import { describe, expect, it } from "vitest";

import { FallbackVisionProvider } from "@/src/infrastructure/providers/fallback-vision-provider";
import { QwenVisionProvider } from "@/src/infrastructure/providers/qwen-vision-provider";
import {
  createConfiguredVisionProvider,
  type VisionProviderSelectionConfig,
} from "@/src/infrastructure/providers/vision-provider-factory";
import type { QwenVisionCompletionClient } from "@/src/providers/vision-provider";

const fallbackConfig: VisionProviderSelectionConfig = {
  AI_MODE: "fallback",
};

const qwenConfig: VisionProviderSelectionConfig = {
  AI_MODE: "qwen",
  DASHSCOPE_API_KEY: "test-key",
  QWEN_BASE_URL: "https://dashscope.example.test/v1",
  QWEN_VISION_MODEL: "qwen-vision-test",
};

const qwenClient: QwenVisionCompletionClient = {
  complete: async () => "{}",
};

describe("configured vision provider", () => {
  it("selects fallback when AI_MODE is fallback", () => {
    const provider = createConfiguredVisionProvider(fallbackConfig);

    expect(provider).toBeInstanceOf(FallbackVisionProvider);
  });

  it("selects Qwen when AI_MODE is qwen without making a network call", () => {
    const provider = createConfiguredVisionProvider(qwenConfig, {
      qwenClient,
      imageLoader: {
        load: async () => [],
      },
    });

    expect(provider).toBeInstanceOf(QwenVisionProvider);
  });
});

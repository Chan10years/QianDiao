import { describe, expect, it, vi } from "vitest";

const openAIComplete = vi.hoisted(() => vi.fn());

vi.mock("openai", () => ({
  default: class MockOpenAI {
    readonly chat = { completions: { create: openAIComplete } };
  },
}));

import { OpenAIQwenVisionClient } from "@/src/infrastructure/providers/openai-qwen-vision-client";

describe("OpenAIQwenVisionClient", () => {
  it("sends image data URLs as multimodal image content", async () => {
    openAIComplete.mockResolvedValue({
      choices: [{ message: { content: '{"ingredients":[]}' } }],
    });
    const client = new OpenAIQwenVisionClient({
      apiKey: "test-key",
      baseURL: "https://dashscope.example.test/v1",
    });

    await client.complete({
      model: "qwen-vision-test",
      prompt: "识别图片中的材料",
      timeoutMs: 1_000,
      jsonSchema: {},
      images: [
        {
          imageId: "11111111-1111-4111-8111-111111111111",
          mime: "image/jpeg",
          dataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD",
        },
      ],
    });

    const request = openAIComplete.mock.calls[0]?.[0] as {
      messages: Array<{
        content: Array<
          | { type: "text"; text: string }
          | { type: "image_url"; image_url: { url: string; detail: string } }
        >;
      }>;
    };
    expect(request.messages[0]?.content).toEqual([
      { type: "text", text: "识别图片中的材料" },
      {
        type: "image_url",
        image_url: {
          url: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD",
          detail: "high",
        },
      },
    ]);
  });
});

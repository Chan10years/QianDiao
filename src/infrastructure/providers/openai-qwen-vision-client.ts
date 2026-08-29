import OpenAI from "openai";

import type {
  QwenVisionCompletionClient,
  QwenVisionCompletionRequest,
} from "@/src/providers/vision-provider";

export interface OpenAIQwenVisionClientOptions {
  apiKey: string;
  baseURL: string;
}

export class OpenAIQwenVisionClient implements QwenVisionCompletionClient {
  private readonly client: OpenAI;

  constructor(options: OpenAIQwenVisionClientOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
    });
  }

  async complete(request: QwenVisionCompletionRequest): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: request.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: request.prompt },
            ...request.images.map((image) => ({
              type: "image_url" as const,
              image_url: { url: image.dataUrl, detail: "high" as const },
            })),
          ],
        },
      ],
      temperature: 0,
    });
    const content = response.choices[0]?.message.content;

    if (content === null || content === undefined) {
      throw new Error("Qwen vision response did not contain content");
    }

    return content;
  }
}

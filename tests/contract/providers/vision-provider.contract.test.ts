import { describe, expect, it } from "vitest";

import { VisionResultSchema } from "@/src/providers/vision-provider";
import { FallbackVisionProvider } from "@/src/infrastructure/providers/fallback-vision-provider";
import { QwenVisionProvider } from "@/src/infrastructure/providers/qwen-vision-provider";
import type {
  QwenVisionCompletionClient,
  QwenVisionCompletionRequest,
  VisionInput,
  VisionImageLoader,
  VisionProvider,
} from "@/src/providers/vision-provider";

const visionInput: VisionInput = {
  overviewImageId: "11111111-1111-4111-8111-111111111111",
  labelImageIds: [],
};

function modelResult(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ingredients: [
      {
        rawName: "二锅头",
        canonicalName: "二锅头",
        category: "spirit",
        brand: "示例酒",
        abv: null,
        confidence: 0.72,
        confirmed: false,
      },
      {
        rawName: "雪碧",
        canonicalName: "雪碧",
        category: "mixer",
        brand: null,
        abv: null,
        confidence: 0.96,
        confirmed: false,
      },
    ],
    needsLabelCloseup: false,
    userQuestions: [],
    ...overrides,
  });
}

class StaticCompletionClient implements QwenVisionCompletionClient {
  readonly requests: QwenVisionCompletionRequest[] = [];

  constructor(private readonly responses: readonly (string | Error)[]) {}

  async complete(request: QwenVisionCompletionRequest): Promise<string> {
    this.requests.push(request);
    const response = this.responses[this.requests.length - 1];
    if (response instanceof Error) {
      throw response;
    }
    if (response === undefined) {
      throw new Error("No static response configured");
    }
    return response;
  }
}

class NeverResolvingCompletionClient implements QwenVisionCompletionClient {
  readonly requests: QwenVisionCompletionRequest[] = [];

  complete(request: QwenVisionCompletionRequest): Promise<string> {
    this.requests.push(request);
    return new Promise<string>(() => undefined);
  }
}

const testImageLoader: VisionImageLoader = {
  load: async (input) => [
    {
      imageId: input.overviewImageId,
      mime: "image/jpeg",
      dataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD",
    },
  ],
};

function qwenProvider(client: QwenVisionCompletionClient, timeoutMs = 1_500): QwenVisionProvider {
  return new QwenVisionProvider({
    client,
    model: "qwen-vision-test-fixture",
    timeoutMs,
    fallback: new FallbackVisionProvider(),
    imageLoader: testImageLoader,
  });
}

async function assertVisionProviderContract(provider: VisionProvider): Promise<void> {
  const result = await provider.recognize(visionInput);

  expect(VisionResultSchema.safeParse(result).success).toBe(true);
  expect(result.ingredients.length).toBeGreaterThan(0);
  expect(result.ingredients.every((ingredient) => ingredient.confirmed === false)).toBe(true);
  expect(["fallback", "qwen"]).toContain(result.sourceMode);
}

describe("VisionProvider contract", () => {
  it("fallback returns editable, schema-valid demo recognition with explicit fallback mode", async () => {
    const provider = new FallbackVisionProvider();

    await assertVisionProviderContract(provider);
    const result = await provider.recognize(visionInput);

    expect(result.sourceMode).toBe("fallback");
    expect(result.ingredients.map((ingredient) => ingredient.category)).toContain("spirit");
    expect(result.needsLabelCloseup).toBe(true);
  });

  it("Qwen adapter parses static output through the shared schema and normalizes controlled names", async () => {
    const client = new StaticCompletionClient([modelResult()]);

    await assertVisionProviderContract(qwenProvider(client));
    const result = await qwenProvider(new StaticCompletionClient([modelResult()])).recognize(
      visionInput,
    );

    expect(result.sourceMode).toBe("qwen");
    expect(result.ingredients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rawName: "二锅头", canonicalName: "白酒", category: "spirit" }),
        expect.objectContaining({ rawName: "雪碧", canonicalName: "柠檬汽水", category: "mixer" }),
      ]),
    );
    expect(result.needsLabelCloseup).toBe(true);
  });

  it("repairs invalid JSON once, then accepts the repaired response", async () => {
    const client = new StaticCompletionClient(["not-json", modelResult()]);
    const result = await qwenProvider(client).recognize(visionInput);

    expect(VisionResultSchema.safeParse(result).success).toBe(true);
    expect(client.requests).toHaveLength(2);
    expect(client.requests[1].prompt).toContain("修复");
  });

  it("falls back after a second invalid response without exposing raw model text", async () => {
    const client = new StaticCompletionClient(["not-json", "still-not-json"]);
    const result = await qwenProvider(client).recognize(visionInput);

    expect(result.sourceMode).toBe("fallback");
    expect(VisionResultSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain("still-not-json");
    expect(client.requests).toHaveLength(2);
  });

  it("falls back on timeout after one provider call", async () => {
    const client = new NeverResolvingCompletionClient();
    const result = await qwenProvider(client, 20).recognize(visionInput);

    expect(result.sourceMode).toBe("fallback");
    expect(VisionResultSchema.safeParse(result).success).toBe(true);
    expect(client.requests).toHaveLength(1);
  });

  it("requests a label closeup for low-confidence or unknown-abv alcohol and keeps unknown names unknown", async () => {
    const result = await qwenProvider(
      new StaticCompletionClient([
        modelResult({
          ingredients: [
            {
              rawName: "神秘酒",
              canonicalName: "神秘酒",
              category: "unknown",
              brand: null,
              abv: null,
              confidence: 0.91,
              confirmed: false,
            },
            {
              rawName: "神秘粉末",
              canonicalName: "神秘粉末",
              category: "unknown",
              brand: null,
              abv: null,
              confidence: 0.91,
              confirmed: false,
            },
          ],
        }),
      ]),
    ).recognize(visionInput);

    expect(result.needsLabelCloseup).toBe(true);
    expect(result.ingredients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ canonicalName: "神秘酒", category: "unknown" }),
        expect.objectContaining({ canonicalName: "神秘粉末", category: "unknown" }),
      ]),
    );
    expect(result.userQuestions.join(" ")).toContain("标签");
  });

  it("keeps the label question when the model already used all five question slots", async () => {
    const result = await qwenProvider(
      new StaticCompletionClient([
        modelResult({
          userQuestions: ["问题一", "问题二", "问题三", "问题四", "问题五"],
        }),
      ]),
    ).recognize(visionInput);

    expect(result.needsLabelCloseup).toBe(true);
    expect(result.userQuestions).toHaveLength(5);
    expect(result.userQuestions.join(" ")).toContain("标签");
  });

  it("passes normalized JPEG image content to the Qwen completion client", async () => {
    const client = new StaticCompletionClient([modelResult()]);
    const provider = new QwenVisionProvider({
      client,
      model: "qwen-vision-test-fixture",
      imageLoader: testImageLoader,
    });

    await provider.recognize(visionInput);

    const request = client.requests[0] as QwenVisionCompletionRequest & {
      images: Array<{ imageId: string; mime: string; dataUrl: string }>;
    };
    expect(request.images).toEqual([
      {
        imageId: visionInput.overviewImageId,
        mime: "image/jpeg",
        dataUrl: expect.stringMatching(/^data:image\/jpeg;base64,/u),
      },
    ]);
    expect(request.prompt).not.toContain("data:image/jpeg;base64");
  });

  it("preserves a model-declared spirit category for an unmapped English alcohol", async () => {
    const result = await qwenProvider(
      new StaticCompletionClient([
        modelResult({
          ingredients: [
            {
              rawName: "Tequila",
              canonicalName: "Tequila",
              category: "spirit",
              brand: null,
              abv: null,
              confidence: 0.86,
              confirmed: false,
            },
          ],
        }),
      ]),
    ).recognize(visionInput);

    expect(result.ingredients).toEqual([
      expect.objectContaining({ rawName: "Tequila", category: "spirit", abv: null }),
    ]);
  });
});

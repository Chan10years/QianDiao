import {
  normalizeVisionResult,
  VisionInputSchema,
  VisionResultSchema,
  type VisionInput,
  type VisionProvider,
  type VisionResult,
} from "@/src/providers/vision-provider";

export class FallbackVisionProvider implements VisionProvider {
  async recognize(input: VisionInput): Promise<VisionResult> {
    const parsedInput = VisionInputSchema.parse(input);
    const result = VisionResultSchema.parse({
      ingredients: [
        {
          rawName: "二锅头",
          canonicalName: "白酒",
          category: "spirit",
          brand: null,
          abv: null,
          confidence: 0.72,
          confirmed: false,
        },
        {
          rawName: "苏打水",
          canonicalName: "苏打水",
          category: "mixer",
          brand: null,
          abv: null,
          confidence: 0.9,
          confirmed: false,
        },
      ],
      needsLabelCloseup: true,
      userQuestions: [
        parsedInput.labelImageIds.length === 0
          ? "请补拍酒类瓶身标签近照。"
          : "请确认标签上的品牌与酒精度（ABV）。",
      ],
      sourceMode: "fallback",
    });

    return normalizeVisionResult(result);
  }
}

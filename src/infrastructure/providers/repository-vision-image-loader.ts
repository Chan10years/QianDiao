import type { ImageReader } from "@/src/providers/image-store";
import type {
  VisionInput,
  VisionImageContent,
  VisionImageLoader,
} from "@/src/providers/vision-provider";
import type { ImageRepository } from "@/src/repositories/image-repository";

interface VisionImageReference {
  id: string;
  role: "overview" | "label_closeup";
}

export class RepositoryVisionImageLoader implements VisionImageLoader {
  constructor(
    private readonly imageRepository: Pick<ImageRepository, "findImageById">,
    private readonly imageReader: ImageReader,
  ) {}

  async load(input: VisionInput): Promise<readonly VisionImageContent[]> {
    const references: VisionImageReference[] = [
      { id: input.overviewImageId, role: "overview" },
      ...input.labelImageIds.map((id) => ({ id, role: "label_closeup" as const })),
    ];

    return Promise.all(
      references.map(async ({ id, role }) => {
        const image = this.imageRepository.findImageById(id);
        if (image === null || image.role !== role) {
          throw new Error("VISION_IMAGE_NOT_FOUND");
        }
        if (image.mime !== "image/jpeg") {
          throw new Error("VISION_IMAGE_NOT_NORMALIZED");
        }

        const bytes = await this.imageReader.read(image.objectKey);
        return {
          imageId: image.id,
          mime: "image/jpeg",
          dataUrl: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`,
        } satisfies VisionImageContent;
      }),
    );
  }
}

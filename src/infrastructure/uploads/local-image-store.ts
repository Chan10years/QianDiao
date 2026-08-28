import { mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type {
  ImageReader,
  ImageStore,
  ImageStoreSaveInput,
  StoredImageObject,
} from "@/src/providers/image-store";

const ObjectKeySchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(overview|label_closeup|final_drink|mixing_step)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/i,
  );

export class InvalidObjectKeyError extends Error {
  readonly code = "INVALID_OBJECT_KEY" as const;

  constructor() {
    super("INVALID_OBJECT_KEY");
    this.name = "InvalidObjectKeyError";
  }
}

function makeObjectKey(input: ImageStoreSaveInput): string {
  const sessionId = z.string().uuid().safeParse(input.sessionId);
  const imageId = z.string().uuid().safeParse(input.imageId);
  if (!sessionId.success || !imageId.success) {
    throw new InvalidObjectKeyError();
  }

  return `${input.sessionId}/${input.role}-${input.imageId}.jpg`;
}

export class LocalImageStore implements ImageStore, ImageReader {
  private readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    this.rootDirectory = path.resolve(rootDirectory);
  }

  private resolveObjectPath(objectKey: string): string {
    if (!ObjectKeySchema.safeParse(objectKey).success) {
      throw new InvalidObjectKeyError();
    }

    const absolutePath = path.resolve(this.rootDirectory, objectKey);
    const relativePath = path.relative(this.rootDirectory, absolutePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new InvalidObjectKeyError();
    }

    return absolutePath;
  }

  async save(input: ImageStoreSaveInput): Promise<StoredImageObject> {
    const objectKey = makeObjectKey(input);
    const absolutePath = this.resolveObjectPath(objectKey);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.bytes, { flag: "wx" });

    return { objectKey };
  }

  async delete(objectKey: string): Promise<void> {
    const absolutePath = this.resolveObjectPath(objectKey);
    try {
      await unlink(absolutePath);
      await rmdir(path.dirname(absolutePath)).catch(() => undefined);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }

  async read(objectKey: string): Promise<Uint8Array> {
    return readFile(this.resolveObjectPath(objectKey));
  }
}

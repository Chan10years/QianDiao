// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImagePreview } from "@/components/scan/image-preview";

describe("ImagePreview", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("creates a fresh live URL when an effect is re-run and revokes replaced URLs", async () => {
    const createdUrls: string[] = [];
    const createObjectURL = vi.fn((file: File) => {
      const url = `blob:${file.name}:${createdUrls.length + 1}`;
      createdUrls.push(url);
      return url;
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    const firstFile = new File(["first"], "first.jpg", { type: "image/jpeg" });
    const secondFile = new File(["second"], "second.jpg", { type: "image/jpeg" });
    const view = render(
      <StrictMode>
        <ImagePreview file={firstFile} />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(screen.getByRole("img", { name: "桌面材料预览" })).toHaveAttribute(
        "src",
        createdUrls.at(-1),
      );
    });

    const firstLiveUrl = createdUrls.at(-1);
    expect(firstLiveUrl).toBeDefined();
    expect(revokeObjectURL).toHaveBeenCalledWith(createdUrls[0]);
    expect(revokeObjectURL).not.toHaveBeenCalledWith(firstLiveUrl);

    view.rerender(
      <StrictMode>
        <ImagePreview file={secondFile} />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(screen.getByRole("img", { name: "桌面材料预览" })).toHaveAttribute(
        "src",
        createdUrls.at(-1),
      );
    });
    const secondLiveUrl = createdUrls.at(-1);
    expect(secondLiveUrl).not.toBe(firstLiveUrl);
    expect(revokeObjectURL).toHaveBeenCalledWith(firstLiveUrl);

    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith(secondLiveUrl);
  });
});

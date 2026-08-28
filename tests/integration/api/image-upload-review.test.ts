import { describe, expect, it } from "vitest";

import { createImageRouteHandlers } from "@/app/api/sessions/[sessionId]/images/route";

const limits = {
  maxBytes: 12 * 1024 * 1024,
  maxPixels: 40_000_000,
  longEdge: 2_048,
  maxRequestBodyBytes: 64,
};

function createHandlers() {
  return createImageRouteHandlers(undefined as never, undefined as never, limits);
}

function context() {
  return { params: Promise.resolve({ sessionId: "not-used" }) };
}

describe("image upload request boundary", () => {
  it("rejects a declared oversized multipart request before formData parsing", async () => {
    const request = new Request("http://localhost/api/sessions/not-used/images", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=review",
        "content-length": "1000",
      },
      body: "partial-body",
    });

    const response = await createHandlers().POST(request, context());

    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("FILE_TOO_LARGE");
  });

  it("rejects an oversized streamed multipart request without Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65));
        controller.close();
      },
    });
    const request = new Request("http://localhost/api/sessions/not-used/images", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=review" },
      body,
      duplex: "half",
    } as RequestInit);

    const response = await createHandlers().POST(request, context());

    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("FILE_TOO_LARGE");
  });

  it("returns 415 for non-multipart requests before reading form data", async () => {
    const request = new Request("http://localhost/api/sessions/not-used/images", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    const response = await createHandlers().POST(request, context());

    expect(response.status).toBe(415);
    expect((await response.json()).error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("returns 400 for malformed multipart bodies instead of an internal error", async () => {
    const request = new Request("http://localhost/api/sessions/not-used/images", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=review" },
      body: "not-a-multipart-body",
    });

    const response = await createHandlers().POST(request, context());

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_REQUEST");
  });
});

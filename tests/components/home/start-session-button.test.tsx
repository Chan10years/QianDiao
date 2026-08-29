// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StartSessionButton } from "@/components/home/start-session-button";

const { pushMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";

function successResponse(): Response {
  return new Response(
    JSON.stringify({
      data: { created: true },
      session: { id: SESSION_ID, state: "SCAN", version: 1 },
    }),
    { status: 201, headers: { "content-type": "application/json" } },
  );
}

describe("StartSessionButton", () => {
  afterEach(() => {
    cleanup();
    pushMock.mockClear();
    vi.restoreAllMocks();
  });

  it("creates a new session through the real API contract and navigates to it", async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(successResponse());
    render(<StartSessionButton fetcher={fetcher} />);

    await user.click(screen.getByRole("button", { name: "开始调饮" }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith(`/session/${SESSION_ID}`);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("/api/sessions");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    expect(body.requestId).toMatch(UUID_V4_PATTERN);
  });

  it("ignores repeated clicks while session creation is pending", async () => {
    const user = userEvent.setup();
    let releaseCreation: (response: Response) => void = () => {};
    const pendingCreation = new Promise<Response>((resolve) => {
      releaseCreation = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(pendingCreation);
    render(<StartSessionButton fetcher={fetcher} />);

    const button = screen.getByRole("button", { name: "开始调饮" });
    await user.click(button);
    await user.click(button);
    await user.click(button);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();

    releaseCreation(successResponse());
    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith(`/session/${SESSION_ID}`);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("shows the server error after a failed creation and retries with a new request", async () => {
    const user = userEvent.setup();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "INTERNAL_ERROR",
              message: "服务器内部错误",
              retryable: true,
            },
          }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(successResponse());
    render(<StartSessionButton fetcher={fetcher} />);

    await user.click(screen.getByRole("button", { name: "开始调饮" }));

    expect(pushMock).not.toHaveBeenCalled();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("服务器内部错误");

    await user.click(screen.getByRole("button", { name: "开始调饮" }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith(`/session/${SESSION_ID}`);
    });
    expect(screen.queryByRole("alert")).toBeNull();

    const firstBody = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(firstBody.requestId).not.toBe(secondBody.requestId);
    expect(secondBody.requestId).toMatch(UUID_V4_PATTERN);
  });
});

import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

async function createTestImage(): Promise<Buffer> {
  return sharp({
    create: {
      width: 24,
      height: 16,
      channels: 3,
      background: { r: 180, g: 120, b: 80 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function startSession(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "开始调饮" }).click();
  await expect(page.getByRole("heading", { name: "你想喝什么感觉？" })).toBeVisible();
}

async function completePreferences(page: Page): Promise<void> {
  await page.getByRole("button", { name: "保存口味，开始拍照" }).click();
  await expect(page.getByRole("heading", { name: "拍照桌面材料" })).toBeVisible();
}

async function recognizeAndConfirmIngredients(page: Page): Promise<void> {
  await page.getByLabel("选择桌面照片").setInputFiles({
    name: "desktop.jpg",
    mimeType: "image/jpeg",
    buffer: await createTestImage(),
  });
  const [recognitionResponse] = await Promise.all([
    page.waitForResponse((response) => {
      return (
        response.request().method() === "POST" &&
        response.url().includes("/recognition") &&
        response.status() === 200
      );
    }),
    page.getByRole("button", { name: "上传照片并识别", exact: true }).click(),
  ]);
  const recognitionBody = await recognitionResponse.json();
  expect(recognitionBody.data.recognition).toMatchObject({
    sourceMode: "fallback",
    needsLabelCloseup: true,
  });
  await expect(page.getByRole("heading", { name: "确认材料" })).toBeVisible();

  await page.getByRole("spinbutton", { name: "材料 1 酒精度（ABV）" }).fill("52");
  await page.getByRole("checkbox", { name: "材料 1 已确认" }).check();
  await page.getByRole("checkbox", { name: "材料 2 已确认" }).check();
  await page.getByRole("button", { name: "确认材料并继续" }).click();
  await expect(page.getByRole("heading", { name: "生成三套配方" })).toBeVisible();
}

async function openRecipeSelection(page: Page): Promise<void> {
  const [recipeResponse] = await Promise.all([
    page.waitForResponse((response) => {
      return (
        response.request().method() === "GET" &&
        response.url().includes("/recipes") &&
        response.status() === 200
      );
    }),
    page.getByRole("button", { name: "生成三套配方", exact: true }).click(),
  ]);
  const recipeBody = await recipeResponse.json();
  expect(recipeBody.data.recipeSet.recipes).toHaveLength(3);
  expect(recipeBody.data.recipeSet.sourceMode).toBe("fallback");
  await expect(page.getByRole("heading", { name: "选择一套配方" })).toBeVisible();
}

async function openMixing(page: Page): Promise<void> {
  await page.getByRole("button", { name: "选这杯" }).click();
  await expect(page.getByRole("heading", { name: /第 1 步：/ })).toBeVisible();
}

async function finishMixing(page: Page): Promise<void> {
  const mixingSteps = page.getByRole("list", { name: "调饮步骤索引" }).getByRole("listitem");
  const totalSteps = await mixingSteps.count();
  for (let stepIndex = 1; stepIndex < totalSteps; stepIndex += 1) {
    const nextButton = page.getByRole("button", { name: "下一步" });
    await nextButton.click();
    await expect(page.locator('[data-step-state="current"]')).toContainText(
      `第 ${stepIndex + 1} 步 · 当前`,
    );
  }
  await page.getByRole("button", { name: "完成最后一步" }).click();
  await expect(page.getByRole("heading", { name: "满意吗？" })).toBeVisible();
}

test("opens a new mobile session at the preferences step", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "黔调" })).toBeVisible();
  await page.getByRole("button", { name: "开始调饮" }).click();

  await expect(page).toHaveURL(/\/session\/[0-9a-f-]+$/i);
  await expect(page.getByRole("heading", { name: "你想喝什么感觉？" })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存口味，开始拍照" })).toBeVisible();
});

test("completes the pivot journey and restores the mixing step after refresh", async ({ page }) => {
  await startSession(page);
  await completePreferences(page);
  await recognizeAndConfirmIngredients(page);
  await openRecipeSelection(page);

  for (let index = 0; index < 3; index += 1) {
    await page.getByRole("button", { name: "不要这杯" }).click();
  }
  await expect(page.getByRole("region", { name: "当前操作" })).toContainText("换一批");
  await page.getByRole("button", { name: "换一批" }).click();
  await expect(page.getByText("第 1 / 3 套")).toBeVisible();

  await openMixing(page);
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByRole("heading", { name: /第 2 步：/ })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: /第 2 步：/ })).toBeVisible();
  await expect(page.getByText("拍摄关键步骤")).toHaveCount(0);

  await page.getByRole("button", { name: "返回上一步" }).click();
  await expect(page.getByRole("heading", { name: /第 1 步：/ })).toBeVisible();
  await finishMixing(page);
  await page.getByRole("button", { name: "满意" }).click();
  await expect(page.getByRole("heading", { name: "满意收尾" })).toBeVisible();
  await page.getByLabel("选择成品照片").setInputFiles({
    name: "final-drink.jpg",
    mimeType: "image/jpeg",
    buffer: await createTestImage(),
  });
  await page.getByRole("button", { name: "上传照片并完成" }).click();
  await expect(page.getByRole("heading", { name: "调饮完成" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "调饮完成" })).toBeVisible();
});

test("recovers from regenerate failure and a stale mixing version", async ({ page }) => {
  await startSession(page);
  await completePreferences(page);
  await recognizeAndConfirmIngredients(page);
  await openRecipeSelection(page);

  for (let index = 0; index < 3; index += 1) {
    await page.getByRole("button", { name: "不要这杯" }).click();
  }

  let failRegeneration = true;
  await page.route("**/api/sessions/*/recipes", async (route) => {
    if (route.request().method() === "POST" && failRegeneration) {
      failRegeneration = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "PROVIDER_UNAVAILABLE", message: "换批服务暂时不可用", retryable: true },
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.getByRole("button", { name: "换一批" }).click();
  await expect(page.getByText("换批服务暂时不可用", { exact: true })).toBeVisible();
  await page.unroute("**/api/sessions/*/recipes");
  await page.getByRole("button", { name: "换一批" }).click();
  await expect(page.getByText("第 1 / 3 套")).toBeVisible();

  await openMixing(page);
  let failAdvance = true;
  await page.route("**/api/sessions/*/mixing/advance", async (route) => {
    if (route.request().method() === "POST" && failAdvance) {
      failAdvance = false;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "VERSION_CONFLICT",
            message: "会话版本已过期，请重新加载",
            retryable: true,
          },
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByRole("heading", { name: /第 1 步：/ })).toBeVisible();
  await expect(page.locator('[role="alert"]').filter({ hasText: "版本" })).toBeVisible();
  await page.unroute("**/api/sessions/*/mixing/advance");
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByRole("heading", { name: /第 2 步：/ })).toBeVisible();
});

test("retries the V2 adjustment after final drink upload failure and can skip", async ({
  page,
}) => {
  await startSession(page);
  await completePreferences(page);
  await recognizeAndConfirmIngredients(page);
  await openRecipeSelection(page);
  await openMixing(page);
  await finishMixing(page);

  await page.getByRole("button", { name: "还想调整" }).click();
  await page.getByRole("button", { name: "提交调整反馈" }).click();
  await expect(page.getByText(/调整方案 · V2/)).toBeVisible();
  await page.getByRole("button", { name: "按这个继续调" }).click();
  await expect(page.getByRole("heading", { name: /第 1 步：/ })).toBeVisible();
  await finishMixing(page);
  await page.getByRole("button", { name: "满意" }).click();
  await expect(page.getByRole("heading", { name: "满意收尾" })).toBeVisible();

  await page.route("**/api/sessions/*/images", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "PROVIDER_UNAVAILABLE", message: "照片上传失败，请重试", retryable: true },
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.getByLabel("选择成品照片").setInputFiles({
    name: "final-drink.jpg",
    mimeType: "image/jpeg",
    buffer: await createTestImage(),
  });
  await page.getByRole("button", { name: "上传照片并完成" }).click();
  await expect(page.getByText("照片上传失败，请重试", { exact: true })).toBeVisible();
  await page.unroute("**/api/sessions/*/images");
  await page.getByRole("button", { name: "跳过，直接完成" }).click();
  await expect(page.getByRole("heading", { name: "调饮完成" })).toBeVisible();
});

test("replays a committed preference save after its response is lost", async ({ page }) => {
  await startSession(page);
  const requestIds: string[] = [];
  let responseLost = false;
  await page.route("**/api/sessions/*/preferences", async (route) => {
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }

    const requestBody = route.request().postDataJSON() as { requestId?: string };
    if (requestBody.requestId !== undefined) requestIds.push(requestBody.requestId);
    if (!responseLost) {
      responseLost = true;
      const response = await route.fetch();
      await response.body();
      await route.abort("connectionreset");
      return;
    }
    await route.continue();
  });

  await page.getByRole("button", { name: "保存口味，开始拍照" }).click();
  await expect(page.getByText("保存没有完成", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "保存口味，开始拍照" }).click();
  await expect(page.getByRole("heading", { name: "拍照桌面材料" })).toBeVisible();
  expect(requestIds).toHaveLength(2);
  expect(requestIds[0]).toBe(requestIds[1]);
});

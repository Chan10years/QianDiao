# Guikesong YQZ Product Pivot Implementation Plan

> **For agentic workers:** 每个实现 Task 必须使用 `superpowers:test-driven-development`；完成前使用 `superpowers:verification-before-completion`。每个 Task 都必须经过 Codex implementation → commit → Claude Code independent Review；Review FAIL 时由 Codex 定点修复并重新审查，PASS 后才能进入下一个 Task。

**Goal:** 在冻结后端基线上完成手机优先的 Product Pivot：每批生成三套 A/B/C，前端单卡 Swipe，三张全拒绝后用户主动换批，使用可恢复 Mixing Stepper，并以满意优先的反馈、可选 final drink 和 Vn+1 调整闭环收尾。

**Architecture:** 继承现有 Next.js 模块化单体、SQLite/Drizzle、应用层用例、状态机、Provider 接口、确定性 Safety、幂等和乐观并发。前端只改变产品交互和恢复体验；新业务动作必须通过 API → Application → Domain/Workflow/Repository/Provider 的既有方向实现，不让 Swipe 直接触碰数据库或 Provider。

**Tech Stack:** Node.js 24 LTS、pnpm、Next.js 16 App Router、React 19、TypeScript strict、Tailwind CSS 4、Zod 4、SQLite、Drizzle ORM/Kit、better-sqlite3、sharp、Vitest 4、React Testing Library、Playwright、ESLint、Prettier。

**Spec:** `docs/superpowers/specs/2026-08-28-guikesong-yqz-product-pivot.md`

**Inherited references:**

- `docs/superpowers/specs/2026-08-21-baijiu-cocktail-agent-design.md`
- `docs/superpowers/specs/2026-08-27-task-13-feedback-loop-design.md`

**Frozen baseline:** 旧工程来源 `815add106fdd196c805cc2cc71941455241f0bfb`；本仓库 baseline `b27c353f71fd7f411697cd659c20face56c63bad`。

## Global constraints

- 当前产品交互和 MVP 范围以 Product Pivot Spec 为最高真相源；旧两个 Spec 只在未被覆盖的后端、架构、安全和 Task 13A/13B 语义上继承。
- 一次只执行一个未完成 Task；当前 Task 0 完成并通过独立 Review 前不得开始 Task 1。
- 初次生成和每次“换一批”都调用 `generate()`，每批恰好三套 A/B/C；Provider 不因 Swipe 改成单候选生成。
- UI 一次只展示一张卡；左滑是前端浏览动作，不是 Feedback、`accepted=false` 或模型调用；三张全拒绝后必须由用户主动点击“换一批”。
- 每个候选在可选择前经过 Zod、确定性 Safety、BLOCK repair/fallback replace 和 recommendation ranking；`BLOCK` 无绕过路径。
- 既有会话变更继续使用 `requestId` 幂等、`expectedVersion` 乐观并发和事务；重复提交、刷新、网络响应丢失不得产生重复副作用。
- 不新增 `FINAL_PHOTO` SessionState；旧 checkpoint photo 的数据和 migration 保留，但新版 Mixing UI 不要求或使用它。
- `FEEDBACK` 首先判断“满意 / 还想调整”；只有不满意才展示四维相对调整和可选备注；`final_drink` 可选，跳过不得阻止 `COMPLETED`。
- 不实现分享、分享海报、社交、拒绝原因调查、云部署、登录、RAG、向量数据库、爬虫、硬件或新前端框架。
- 不修改已发布 migration；本计划不能删除旧 checkpoint migration。
- 不安装新依赖，除非先更新正式规格和本计划并取得用户确认。
- 每个实现 Task 遵循 Red → Green → Review → Green 修复循环；Codex 与 Claude Code 不同时写同一代码。

## E2E 分阶段规则

Task 7 建立真实可执行 Playwright E2E 前，Frozen Baseline 的 `pnpm test:e2e` 返回 `No tests found` 是已知的非阻塞缺口，不阻塞 Task 1–6 的 task gate。Task 7 必须建立真实可执行 Playwright E2E，不接受 `No tests found`；建立后 `pnpm test:e2e` 对 Task 7、Task 8 和最终 release 都是阻塞门禁。`PRODUCTION.md` 的最终 release gate 继续要求 E2E 全绿。

## Review protocol

每一个实现 Task 的固定门禁：

1. Codex 调查当前接口，写行为失败测试并确认失败原因属于本 Task。
2. Codex 写最小实现，运行 Task 局部测试和受影响的更大门禁。
3. Codex 只提交本 Task 范围内文件。
4. Claude Code 作为全新独立 Reviewer，只读检查实现、测试、范围和证据，输出 `PASS/FAIL + Critical/Important/Minor findings`；默认不修改生产代码、测试、migration 或文档。
5. FAIL 时 Codex 只修复 Reviewer 指出的实际问题，再由 Claude Code 复审；Critical/Important 未清零不能继续。
6. PASS 后才允许进入下一个 Task。

## Task 0: Product Pivot Documentation & Baseline Lock

**Goal:** 把新产品交互、继承边界、运行规范和 Task 计划锁定为可审阅文档，并证明本轮没有 Product Pivot 生产代码变更。

**Scope:** 新建 Product Pivot Spec；精确归档旧 Task；更新 `AGENTS.md` 的使命、真相源、Product Pivot 不变量、Agent 分工和 E2E 缺口；更新 `PRODUCTION.md` 的运行真相源、Ready、故障矩阵和演示检查表；重写当前 Task 0–8 计划。

**Explicit non-scope:** 不改 `src/`、`app/`、`components/`、`tests/`、`drizzle/`、`scripts/`、`package.json`、`pnpm-lock.yaml`；不实现 Swipe、regenerate、Mixing redesign、Feedback UI、final photo、状态机或 Provider。

**Files:**

- Create: `docs/superpowers/specs/2026-08-28-guikesong-yqz-product-pivot.md`
- Create exact archive: `docs/baseline/Task-frozen-pre-pivot.md`
- Modify: `AGENTS.md`
- Modify: `PRODUCTION.md`
- Replace: `Task.md`
- Preserve unchanged: `docs/superpowers/specs/2026-08-21-baijiu-cocktail-agent-design.md`, `docs/superpowers/specs/2026-08-27-task-13-feedback-loop-design.md`

**Tests:**

- `git diff --check`
- If Markdown is included by the repository formatter, `pnpm format:check`
- Read-only scope audit for production paths, migration, package and lockfile

**Steps:**

- [x] 核对 `HEAD`、branch、status、package.json 和 app/components/src/tests/drizzle 结构。
- [x] 将旧 `Task.md` 原样复制到 `docs/baseline/Task-frozen-pre-pivot.md`，用 SHA-256 证明字节一致。
- [x] 写 Product Pivot Spec，并只覆盖 Recipe Selection、Reject-all、Mixing、Feedback、Final drink、状态、范围和已知缺口。
- [x] 更新 AGENTS、PRODUCTION 与当前执行计划，保持继承架构和安全规则不被静默改写。
- [x] 运行文档格式、范围和一致性验证。
- [x] 提交文档变更，停止等待独立 Reviewer。

**Acceptance:** 新 Spec 成为产品交互/MVP 最高真相源；旧 Task 完整归档；根 Task 不再要求旧 Task 14–17 或旧 Task 13C；四份当前文档明确同一 Product Pivot；生产代码、测试、migration、package 和 lockfile 无改动。

**Verification:** `git diff --check` 通过；归档文件与修改前 `Task.md` 哈希一致；`git diff --stat`、`git status` 和允许路径审计均符合范围。完整 E2E、手机和 Provider 验证留后续 Task。

**Commit message:** `docs: lock Guikesong YQZ product pivot baseline`

**Reviewer gate:** Claude Code 独立只读审查本 Task；输出 `PASS/FAIL + Critical/Important/Minor findings`。本 Task PASS 前不得开始 Task 1。

## Task 1: Visual System & Mobile Shell

**Goal:** 建立新版手机优先视觉系统和状态驱动 Mobile Shell，让每个页面一屏只有一个主动作，并为单卡、Stepper、满意优先反馈提供一致容器。

**Scope:** 颜色、排版、间距、触控尺寸、响应式单列布局、进度头、底部主操作栏、加载/错误/恢复状态和状态到页面的壳层映射；保留既有服务端渲染与客户端 SessionShell 结构。

**Explicit non-scope:** 不改任何 Recipe/Feedback/Adjustment/图片业务合同；不实现 Swipe、换一批、Mixing Stepper 细节、final photo 或新的 SessionState；不新增 React、npm 或其他前端框架。

**Files:**

- Modify: `app/globals.css`, `app/layout.tsx`
- Modify: `components/session/session-shell.tsx`, `components/session/progress-header.tsx`, `components/session/fixed-action-bar.tsx`
- Modify only for shell wiring: `components/preferences/preferences-screen.tsx`, `components/scan/camera-screen.tsx`, `components/ingredients/ingredient-confirmation-screen.tsx`
- Test: `tests/components/preferences/session-shell.test.tsx`, `tests/components/preferences/preferences-screen.test.tsx`, `tests/components/scan/camera-screen.test.tsx`
- Create if needed: `tests/components/session/mobile-shell.test.tsx`

**Tests:** RTL 断言手机单列、主动作可达、加载/错误/重试、已有状态恢复；已有偏好/拍照/确认组件测试；`pnpm lint`、`pnpm format:check`、`pnpm typecheck`。

**Steps:**

- [x] 先补视觉契约测试：390×844 视口下 shell、主 CTA 和错误恢复语义。
- [x] 运行目标测试确认 RED，记录失败断言。
- [x] 实现最小 tokens、布局和壳层，不改变 API payload。
- [x] 运行组件测试及质量门禁，修正真实失败。
- [ ] 提交后交 Claude Code 独立 Review。

**Acceptance:** PREFERENCES/SCAN/CONFIRM/READY/RECIPE_SELECTION/MIXING 等既有状态共享可读的手机壳；按钮触控区域达到项目既定要求；加载、失败、重试和刷新恢复可见；业务测试合同不变。

**Verification:** 定向组件测试、`pnpm lint`、`pnpm format:check`、`pnpm typecheck` 和必要的真实浏览器截图/检查均有输出。

**Commit message:** `feat: establish product pivot mobile shell`

**Reviewer gate:** Codex commit 后由 Claude Code 独立只读审查；PASS 后才进入 Task 2。

## Task 2: Recipe Swipe Deck

**Goal:** 在不改变初次生成后端合同的前提下，把三套候选改成按 recommendation ranking 逐张浏览的单卡 Swipe Deck。

**Scope:** 复用当前 Recipe Set 三张数据；首张显示推荐排序第一名；左滑进入本批下一张；右滑调用现有 `selectRecipe`；`WARN` 继续显式确认；本批内不产生任何新的 Provider 调用。

**Explicit non-scope:** 不实现 regenerate/换一批；不修改 `generate()`、RecipeCandidateSet、Safety、Repository、migration 或状态机；不把左滑写成 `accepted=false` 或 Feedback；不展示三张卡同时作为主交互。

**Files:**

- Modify: `components/recipes/recipe-selection-screen.tsx`, `components/recipes/recipe-card.tsx`, `components/session/session-shell.tsx`
- Modify only if required by existing method typing: `src/infrastructure/http/session-client.ts`
- Test: `tests/components/recipes/recipe-selection-screen.test.tsx`
- Create if needed: `tests/components/recipes/recipe-swipe-deck.test.tsx`
- Investigate only before implementation: `src/application/get-recipe-set.ts`, `src/repositories/recipe-repository.ts`, `src/infrastructure/repositories/drizzle-recipe-repository.ts`
- Preserve backend contracts: `src/application/generate-recipe-set.ts`, `src/application/select-recipe.ts`, `app/api/sessions/[sessionId]/recipes/route.ts`, `app/api/sessions/[sessionId]/selection/route.ts`

**Tests:** 初始顺序为 recommendation ranking 第一名；始终只有一张可见卡；左滑只更新本地 deck index 且 client spy 无调用；右滑只调用 `selectRecipe`；WARN 未确认不能右滑；最后一张左滑显示“换一批”入口但不调用 regenerate。实现前还必须验证 `generate` response → GET recipe set → Repository 持久化读取的顺序稳定保持 recommendation-ranked order；不得重新按 A/B/C 排序。

**Steps:**

- [x] 实现前验证 `generate` response、GET recipe set 和 Repository 持久化读取之间的顺序，确认 recommendation-ranked order 稳定传递；不得重新按 A/B/C 排序。
- [ ] 如果无法证明 ranking 顺序稳定，先停止 Task 2 UI 实现，在 Decision Log 报告最小稳定暴露方案（例如由服务端持久化或返回显式 ranking position），取得用户最终决定后再写 UI RED 测试。
- [x] 从当前 ranking 输出和组件行为写 RED 测试，禁止测试依赖 A/B/C 顺序。
- [x] 运行定向组件测试确认 RED。
- [x] 实现最小本地 deck cursor、手势/键盘等价操作和右滑选择。
- [ ] 运行组件测试、全量 Vitest 和质量门禁。
- [ ] 提交并等待独立 Review；不进入 Task 3 直到 PASS。

**Acceptance:** 单卡首屏是推荐方案；左滑只浏览当前 batch；右滑成功进入现有 MIXING；三张全左滑后只有用户可见的“换一批”入口，没有隐式生成。

**Verification:** 定向 RTL、`pnpm test`、`pnpm lint`、`pnpm format:check`、`pnpm typecheck`；至少一次持久化真实浏览器路径证明 refresh 后仍回到可恢复 Recipe Selection。

**Commit message:** `feat: add ranked recipe swipe deck`

**Reviewer gate:** Claude Code 独立只读审查卡片语义、无后端副作用、可访问操作和范围；PASS 后才进入 Task 3。

## Task 3: Reject All → Regenerate Batch

**Goal:** 实现三张候选全部左滑后，只有用户主动点击“换一批”才触发新三卡生成，并让新批次重新经过完整安全和推荐管线。

**Scope:** 调查现有 `generateRecipeSet` 是否能在 `RECIPE_SELECTION` 再调用；实现被用户选定的 regenerate API 方案、requestId/expectedVersion 幂等并发、批次替换/保留策略、错误恢复和单卡 deck 重置。

**Explicit non-scope:** 不把左滑变成 API；不每次左滑调用模型；不生成单卡；不修改 Provider `generate()` 使其返回一张；不新增 SessionState；不实现 Feedback 或 Mixing redesign。

**Files:**

- Investigate/likely modify: `src/application/generate-recipe-set.ts`, `src/application/get-recipe-set.ts`, `src/repositories/recipe-repository.ts`, `src/infrastructure/repositories/drizzle-recipe-repository.ts`
- Investigate/likely modify: `app/api/sessions/[sessionId]/recipes/route.ts`, `src/infrastructure/routes/recipe-route-dependencies.ts`
- Modify: `components/recipes/recipe-selection-screen.tsx`, `components/session/session-shell.tsx`, `src/infrastructure/http/session-client.ts`
- Test: `tests/integration/application/generate-recipe-set.test.ts`, `tests/integration/api/recipe-routes.test.ts`, `tests/components/recipes/recipe-selection-screen.test.tsx`
- Create if needed: `src/application/regenerate-recipe-set.ts`, `app/api/sessions/[sessionId]/recipes/regenerate/route.ts`, `tests/integration/application/regenerate-recipe-set.test.ts`, `tests/integration/api/regenerate-recipe-route.test.ts`
- Do not modify: `drizzle/` migrations unless a separately approved schema change is added to the product plan; default choice is no migration.

**Tests:** 新动作只在三张全拒绝后由点击触发；每次返回恰好 A/B/C；新批次重跑 Zod、Safety、BLOCK repair/fallback、ranking；失败保留 RECIPE_SELECTION 和可恢复旧数据；重复 requestId 不重复生成；旧 expectedVersion 返回冲突；左滑本身零 Provider/API 调用。

**API decision checkpoint（必须在实现前记录并取得用户决定）：**

1. **方案 A：扩展既有 `POST /api/sessions/{sessionId}/recipes`。** 优点是复用 `generateRecipeSet` 的安全、幂等和路由依赖；代价是需要明确区分 READY 首次生成与 RECIPE_SELECTION 换批，定义旧批次替换/历史审计语义，避免复用旧 `hasRecipeSet=false` Guard 造成回归。
2. **方案 B：新增 `POST /api/sessions/{sessionId}/recipes/regenerate` 和独立 Application use case。** 优点是语义、审计和状态 Guard 独立清楚；代价是新增 Route/客户端合同，并要复用而不是复制现有 Safety、Provider、租约和持久化逻辑。

在没有用户决定前，Codex 只完成调查、失败测试和候选方案记录，不实现 A 或 B。无论最终选择哪一方案，都不得改变 `generate()` 一批三卡的合同。

**Steps:**

- [ ] 完成 `generateRecipeSet`、Recipe Repository、route、幂等和 state guard 调查，写出当前不可直接复用点。
- [ ] 记录方案 A/B 的选择、替代方案和后果；取得用户最终决定。
- [ ] 先写 RED：三张全拒绝后点击触发、重复请求、版本冲突、Safety-invalid 候选和 Provider 失败。
- [ ] 运行定向测试确认失败原因对应 regenerate。
- [ ] 实现最小选定 API，保证外部 Provider 调用不持有长数据库事务。
- [ ] 运行应用/API/组件测试和全量门禁，提交并独立 Review。

**Acceptance:** 三张全拒绝不会自动生成；主动点击才产生一次新的 3-card batch；新批次完成 Zod/Safety/ranking；成功后仍在 RECIPE_SELECTION，直到右滑；失败可重试且不丢当前会话；无新状态、无 migration。

**Verification:** API/application/组件定向测试、`pnpm test`、`pnpm lint`、`pnpm format:check`、`pnpm typecheck`；记录实际采用的 API 方案和完整 requestId/expectedVersion 证据。

**Commit message:** `feat: add explicit recipe batch regeneration`

**Reviewer gate:** Claude Code 独立审查 API 决策、批次持久化、Safety、幂等并发和“左滑无副作用”；Critical/Important 清零并 PASS 后才进入 Task 4。

## Task 4: Mixing Stepper Redesign

**Goal:** 将接受后的调制体验改成纵向 Step Index/Stepper，同时保留 currentStep、前进、后退和 refresh 恢复。

**Scope:** Mixing UI 的步骤索引、当前步骤内容、用量、前进/后退、错误和恢复；复用现有 `advanceMixing` 与 session snapshot；新版流程不显示、不要求、不上传 checkpoint photo。

**Explicit non-scope:** 不删除 `mixing_step`/checkpoint 数据、Repository、旧 route 或 migration；不新增 `FINAL_PHOTO`；不修改 Safety、Recipe、Feedback 后端；不把客户端 state 当成持久化事实。

**Files:**

- Modify: `components/mixing/mixing-screen.tsx`, `components/session/session-shell.tsx`
- Modify only if necessary for existing client types: `src/infrastructure/http/session-client.ts`
- Preserve: `src/application/advance-mixing.ts`, `app/api/sessions/[sessionId]/mixing/advance/route.ts`, `drizzle/`
- Test: `tests/components/mixing/mixing-screen.test.tsx`, `tests/integration/application/advance-mixing.test.ts`, `tests/integration/api/mixing-routes.test.ts`
- Retire from rendered path only; do not delete: `tests/components/mixing/mixing-photo-checkpoint.test.tsx` and legacy checkpoint implementation files

**Tests:** 垂直 Stepper 显示当前/已完成/待完成；前进和后退调用既有 API；第一步不能后退；最后一步进入 FEEDBACK；页面不渲染 checkpoint photo 入口；模拟 refresh 使用服务端 currentStep 恢复；网络/409 不偷偷推进。

**Steps:**

- [ ] 先写 RED 组件和恢复测试，锁定旧 checkpoint 不再是 UI 前置条件。
- [ ] 运行定向测试确认 RED。
- [ ] 实现最小 Stepper 和错误恢复。
- [ ] 运行组件、应用、API 和全量门禁。
- [ ] 提交后由 Claude Code 独立 Review。

**Acceptance:** 用户可看到清晰纵向步骤、当前内容和前后动作；refresh 保持 currentStep；任何 Mixing 步骤都不要求过程照；旧数据库/migration 完整保留。

**Verification:** 定向 Mixing 测试、`pnpm test`、`pnpm lint`、`pnpm format:check`、`pnpm typecheck`，以及真实浏览器 refresh 路径。

**Commit message:** `feat: redesign mixing as resumable stepper`

**Reviewer gate:** Claude Code 独立审查状态恢复、边界、旧数据兼容和无 checkpoint 强制路径；PASS 后才进入 Task 5。

## Task 5: Satisfaction-first Feedback & Adjustment UI

**Goal:** 在 FEEDBACK 首先询问“满意吗？”；“满意”只进入客户端 `satisfied-closing` phase，“还想调整”才展示四维相对反馈并接通已完成的 Vn+1 后端闭环。

**Scope:** 满意/还想调整首屏、客户端 `satisfied-closing` phase、四维 `-2..+2` 调整、可选备注、`accepted=false` 反馈保存、生成唯一 proposal、接受 proposal 后重新 MIXING；显示版本和 Safety 摘要，处理错误/重试/409。

**Explicit non-scope:** 不在本 Task 保存 `accepted=true`、不调用 `completeSession`、不推进 `COMPLETED`；不实现 satisfied-closing 后的 final drink 拍摄/跳过，该职责属于 Task 6；不新增 Feedback/Adjustment 数据模型或 SessionState；不做三张全拒绝原因调查；不修改 13A/13B 后端合同，除非测试证明现有 UI adapter 无法合法调用且先记录决策。

**Files:**

- Create: `components/feedback/satisfaction-screen.tsx`, `components/feedback/adjustment-screen.tsx`
- Modify: `components/session/session-shell.tsx`, `src/infrastructure/http/session-client.ts`
- Reuse: `src/application/save-feedback.ts`, `src/application/generate-adjustment.ts`, `src/application/accept-adjustment.ts`, `src/application/get-current-recipe.ts`, `src/application/get-recipe-version-chain.ts`
- Reuse routes: `app/api/sessions/[sessionId]/feedback/route.ts`, `app/api/sessions/[sessionId]/adjustments/route.ts`, `app/api/sessions/[sessionId]/accept-adjustment/route.ts`
- Test: `tests/integration/application/feedback-adjustment.test.ts`, `tests/integration/api/task-13-feedback-routes.test.ts`
- Create: `tests/components/feedback/satisfaction-screen.test.tsx`, `tests/components/feedback/adjustment-screen.test.tsx`

**Tests:** FEEDBACK 首屏只显示满意/还想调整；点击满意只进入客户端 `satisfied-closing` phase，不调用 `saveFeedback`、不调用 `completeSession`、不保存 `accepted=true`、不进入 `COMPLETED`；满意 phase 不先显示四维滑杆；点击还想调整才显示四维和备注，并调用 `saveFeedback(accepted=false)` 进入 `ADJUSTMENT`；只生成一张 Vn+1；proposal 未接受前 current recipe 不替换；接受后 currentStep 重置并进入 MIXING；V2/V3 版本链可持续。

**Steps:**

- [ ] 先补 RED 组件和集成测试，覆盖满意优先与 Vn+1 绑定。
- [ ] 运行定向测试确认 RED。
- [ ] 实现 UI adapter，复用既有后端和错误/幂等恢复。
- [ ] 运行定向测试、全量 Vitest 和质量门禁。
- [ ] 提交并等待独立 Review。

**Acceptance:** 满意只进入客户端 satisfied-closing phase，不保存 `accepted=true`、不调用 `completeSession`、不推进 `COMPLETED`；不满意才出现四维调整并保存 `accepted=false`；Vn+1 只针对当前实际配方生成并经既有 Safety；接受后回到 MIXING；不能通过 UI 绕过状态机或 BLOCK。

**Verification:** 组件、应用、API 测试，`pnpm test`、`pnpm lint`、`pnpm format:check`、`pnpm typecheck`，以及刷新后 FEEDBACK/ADJUSTMENT 恢复路径。

**Commit message:** `feat: add satisfaction first feedback loop`

**Reviewer gate:** Claude Code 独立审查 accepted 语义、反馈版本链、proposal/current 分离、幂等并发和 Safety；PASS 后才进入 Task 6。

## Task 6: Optional Final Drink Photo & Completed UI

**Goal:** 接手 Task 5 的 `satisfied-closing` phase，提供可选 final drink 拍摄，并在拍摄成功或明确跳过后保存满意反馈并完成会话。

**Scope:** 接手 satisfied-closing；提供满意后的 final drink 邀请、相机/文件选择、预览、上传失败重试、跳过；在用户拍摄或跳过后调用 `saveFeedback(accepted=true, finalImageId=uuid|null)`，再调用 `completeSession`，展示 Completed 页面并支持完成状态恢复；复用 `final_drink` image role、现有上传安全和 Feedback/complete 后端能力。

**Explicit non-scope:** 不新增 `FINAL_PHOTO` SessionState；不把 final photo 设为必填；不实现分享、海报、社交、质量/医学判断；不删除旧 checkpoint image 数据。

**Files:**

- Create: `components/feedback/final-drink-photo.tsx`, `components/session/completed-screen.tsx`
- Modify: `components/session/session-shell.tsx`, `src/infrastructure/http/session-client.ts`
- Reuse: `app/api/sessions/[sessionId]/images/route.ts`, `src/application/upload-session-image.ts`, `src/application/save-feedback.ts`, `src/application/complete-session.ts`
- Test: `tests/components/feedback/final-drink-photo.test.tsx`, `tests/components/session/completed-screen.test.tsx`
- Extend: `tests/integration/api/task-13-feedback-routes.test.ts`, `tests/integration/application/feedback-adjustment.test.ts`

**Tests:** Task 5 的 satisfied-closing 在 final drink 选择前不保存满意反馈；final drink 上传成功后保存 `accepted=true` 和 UUID `finalImageId`，再调用 `completeSession` 进入 COMPLETED；上传失败可以重试或跳过；跳过先保存 `accepted=true` 和 `finalImageId=null`，再调用 `completeSession` 进入 COMPLETED；满意带照和满意无照两条路径都可 refresh 恢复到 Completed；final photo 失败不破坏可跳过的满意路径；不出现新状态。

**Steps:**

- [ ] 先写 RED 组件/集成测试，覆盖拍照、跳过、失败恢复和 Completed。
- [ ] 运行定向测试确认 RED。
- [ ] 实现最小 final drink UI 和完成页面。
- [ ] 运行全量测试、质量门禁和真实浏览器两条满意路径。
- [ ] 提交后由 Claude Code 独立 Review。

**Acceptance:** 用户满意后由 Task 6 接手 satisfied-closing，可拍或跳过 final drink；在拍摄/跳过之后才保存 `accepted=true` 与 `finalImageId(uuid|null)`，再调用 `completeSession`；上传失败仍有跳过出口；两条路径都合法进入 `COMPLETED`；没有 `FINAL_PHOTO` 状态或分享入口。

**Verification:** 定向组件/API/应用测试、`pnpm test`、`pnpm lint`、`pnpm format:check`、`pnpm typecheck` 和持久化浏览器路径。

**Commit message:** `feat: add optional final drink completion flow`

**Reviewer gate:** Claude Code 独立审查 finalImageId 可选性、跳过恢复、完成状态和范围；PASS 后才进入 Task 7。

## Task 7: Full Recovery + Playwright E2E

**Goal:** 真正建立可执行 Playwright E2E，覆盖 Product Pivot 完整闭环、恢复和关键错误路径；从此 `pnpm test:e2e` 重新成为阻塞发布门禁。

**Scope:** fallback Provider 下的真实浏览器流程：偏好 → 桌面拍照 → 识别确认 → 三卡生成 → 单卡 Swipe → 三张全拒绝 → 主动换批 → 右滑 → Mixing Stepper → refresh currentStep → 满意拍 final drink/跳过；另覆盖不满意 → V2 → 接受 → MIXING → 再次满意。覆盖重复请求、网络响应丢失、regenerate 失败、final photo 上传失败后跳过。

**Explicit non-scope:** 不把组件测试冒充 E2E；不跳过 regenerate 或反馈；不接真实 Qwen 或真实手机硬件；不修改 migration；不接受 `No tests found` 作为 Task 7 验收结果。

**Files:**

- Create: `tests/e2e/product-pivot.spec.ts`, `tests/e2e/fixtures.ts`（如需要）
- Modify: `playwright.config.ts`, `src/infrastructure/http/session-client.ts`, `components/session/session-shell.tsx` 仅为真实恢复缺陷
- Modify only when a reproduced E2E defect requires it: relevant route/application/component files
- Preserve: production secrets, real `data/`, user images and package lock unless separately authorized

**Tests:** `pnpm test:e2e` 至少有可执行测试并覆盖完整流程、移动视口、refresh、网络错误恢复、幂等重放和两条满意路径；失败时保留 trace/screenshot 等可审计产物但不提交用户数据。

**Steps:**

- [ ] 先写第一个真正可运行的 RED E2E，确认不是 `No tests found`。
- [ ] 配置隔离 test database/upload directory 和 deterministic fallback fixture。
- [ ] 实现完整流程 E2E 与网络故障注入，先让关键断言 GREEN。
- [ ] 运行 `pnpm test:e2e`、全量质量门禁和空数据库迁移回归。
- [ ] 提交并等待独立 Review；Review PASS 后才进入 Task 8。

**Acceptance:** `pnpm test:e2e` 实际发现并执行测试；完整闭环和恢复场景可重复；任何关键 E2E 失败阻塞发布；测试不触碰真实 `data/` 或秘密。

**Verification:** `pnpm test:e2e`、`pnpm lint`、`pnpm format:check`、`pnpm typecheck`、`pnpm test`、`pnpm build`，以及空临时 SQLite 迁移验证。

**Commit message:** `test: cover product pivot journey with playwright`

**Reviewer gate:** Claude Code 独立审查 E2E 是否真实执行、路径是否完整、隔离是否可信、失败证据是否可读；PASS 后才进入 Task 8。

## Task 8: Real Provider + Real Phone Demo Freeze

**Goal:** 在不改变 Product Pivot 范围的前提下，用真实 Provider、真实手机和本地 fallback 完成最终 Demo 彩排并冻结可复现运行证据。

**Scope:** 受控 `.env.local` 下的真实 Vision/Recipe Provider smoke、超时/401/403/429/5xx 分类、fallback 对照、真实手机局域网流程、三次完整演示、至少一次 V3、备份/恢复和最终发布记录。

**Explicit non-scope:** 不上云、不登录、不加新 Provider 架构、不抓取小红书、不把真实密钥写入仓库/日志/截图、不以一次成功 smoke 代替三次手机彩排。

**Files:**

- Modify only with actual reproducible evidence: `PRODUCTION.md`, `Task.md`
- Read/verify: `.env.example`, `src/config/env.ts`, `src/infrastructure/providers/qwen-vision-provider.ts`, `src/infrastructure/providers/qwen-recipe-provider.ts`, `scripts/db-migrate.ts`, backup tooling if present
- Runtime-only, never commit: `.env.local`, `data/`, `backups/`, screenshots containing user data or secrets

**Tests:** 真实 Provider smoke、fallback smoke、`pnpm test:e2e`、全量质量门禁、空数据库迁移两次、SQLite integrity/backup restore、PRODUCTION 演示前人工清单。

**Steps:**

- [ ] 配置真实 Provider 前确认密钥不在 shell history、日志、截图或 Git diff。
- [ ] 运行视觉和配方真实 smoke，验证响应仍经同一 Zod/Safety 管线。
- [ ] 模拟 Provider 错误和 fallback，记录稳定错误码与恢复标准。
- [ ] 用同一笔记本、手机、网络和浏览器完成三次完整 Product Pivot 闭环；至少一次继续到 V3。
- [ ] 关闭真实 Provider 再跑一次 fallback 闭环。
- [ ] 完成备份/恢复演练和 PRODUCTION 检查表，只记录可复现事实。
- [ ] 运行最终门禁并提交冻结记录。

**Acceptance:** 真实 Provider 与 fallback 均能完成闭环；真实手机三次无阻断；单卡、换批、Stepper、满意拍照/跳过、Vn+1 均有证据；备份可恢复；发布门禁和 E2E 全绿；无秘密/用户图片/真实数据库入 Git。

**Verification:** `pnpm lint`、`pnpm format:check`、`pnpm typecheck`、`pnpm test`、`pnpm test:e2e`、`pnpm build`、空库 `pnpm db:migrate`/`pnpm db:seed`、备份恢复和真实手机人工清单。

**Commit message:** `chore: freeze real provider and mobile demo`

**Reviewer gate:** Claude Code 最终独立只读审查完整验收、自动门禁、真实浏览器/手机证据、秘密和 Git 状态；PASS 后才可称 Product Pivot Demo 冻结。

## Dependency map

```text
Task 0 Documentation & Baseline Lock
  ↓
Task 1 Visual System & Mobile Shell
  ↓
Task 2 Recipe Swipe Deck
  ↓
Task 3 Reject All → Regenerate Batch
  ↓
Task 4 Mixing Stepper Redesign
  ↓
Task 5 Satisfaction-first Feedback & Adjustment UI
  ↓
Task 6 Optional Final Drink Photo & Completed UI
  ↓
Task 7 Full Recovery + Playwright E2E
  ↓
Task 8 Real Provider + Real Phone Demo Freeze
```

## Definition of Done

- [ ] Product Pivot Spec、AGENTS、PRODUCTION、Task 和实际代码边界一致。
- [ ] 每批初次/换批都恰好三套 A/B/C；UI 单卡且按 recommendation ranking 展示。
- [ ] 左滑无后端副作用；三张全拒绝后只有主动点击才 regenerate。
- [ ] 右滑通过既有 select 进入 MIXING；Stepper currentStep 可刷新恢复且不要求 checkpoint photo。
- [ ] Satisfaction-first、Vn+1、final drink 拍摄/跳过和两条 COMPLETED 路径均可用。
- [ ] `FINAL_PHOTO` 不存在；分享、拒绝原因调查和旧 Task 13C 不进入当前 MVP。
- [ ] 所有候选和调整版本经 Zod、deterministic Safety；BLOCK 无绕过。
- [ ] `requestId`、`expectedVersion`、事务和刷新恢复在新增路径成立。
- [ ] Task 7 之后 `pnpm test:e2e` 不再是 `No tests found`，并作为阻塞门禁。
- [ ] Task 8 真实 Provider/fallback、真实手机三次彩排、备份恢复和最终门禁有证据。

## Progress log

```text
YYYY-MM-DD | Task N | commit <sha>
验证：<实际命令与结果>
结果：<完成内容>
风险：<无 / 具体遗留>
```

当前：

- 2026-08-28 | Task 0 | Documentation Pivot review fix commit（GPT re-review pending）
  - 验证：已完成规定文档读取、冻结 baseline/结构调查、旧 Task 原样归档；本轮运行 `git diff --check`、当前文档 targeted Prettier check 和范围审计；完整 `pnpm format:check` 仅因 frozen archive 保持历史字节不变而报告格式警告。
  - 结果：已明确 Task 5/6 的 satisfied-closing、`accepted=true`、`completeSession` 和 `COMPLETED` 顺序；已补齐 Task 1–6 的非阻塞 E2E 缺口规则和 Task 2 ranking 稳定性前置调查；尚未开始任何 Product Pivot 生产代码。
  - 风险：GPT 独立 Reviewer 尚未重新审查；当前 baseline 的 `pnpm test:e2e` 已知为 `No tests found`，必须由 Task 7 补齐并在建立后恢复为阻塞门禁。
- 2026-08-28 | Task 1 | implementation commit pending independent Review
  - 验证：定向组件测试 5 files / 22 passed；`pnpm lint` 0 errors（3 个既有 `<img>` warnings）；Task 1 文件 Prettier check 通过；`pnpm typecheck` 通过；`pnpm test` 64 files / 390 passed / 2 skipped；`pnpm build` 通过；`pnpm test:e2e` 返回 `No tests found`；390×844 与 320px 浏览器几何检查通过。
  - 结果：建立白瓷/米纸/酒液琥珀视觉 tokens、统一 Mobile Shell、进度语义、FixedActionBar safe-area/内容 reserve、Preferences/Scan/Confirmation 共享页面结构与 loading/error/recovery 表达；未改变既有业务 payload 和状态推进。
  - 风险：完整 `pnpm format:check` 仍被未修改的 `docs/baseline/Task-frozen-pre-pivot.md` 历史格式警告阻塞；浏览器 CLI 在当前 Windows 受限环境无法启动，改用 Chrome CDP 设备指标完成真实页面检查；独立 Reviewer 尚未审查。
- 2026-08-29 | Task 1R | Prototype Visual Integration implementation commit（本 changeset，independent Review pending）
  - 验证：Task 1R 定向组件测试 8 files / 25 passed；`pnpm lint` 0 errors（3 个 `<img>` warnings）；`pnpm typecheck` 通过；`pnpm test` 64 files / 390 passed / 2 skipped；Task 1R 修改文件 targeted Prettier 全部 unchanged；`git diff --check` 通过；`pnpm build` 通过。完整 `pnpm format:check` 仍仅因未修改的 frozen archive `docs/baseline/Task-frozen-pre-pivot.md` 报告历史格式警告；`pnpm test:e2e` 仍为 Task 7 前已知的 `No tests found` 非阻塞缺口。
  - 浏览器：使用 fallback Provider、隔离 SQLite 和上传目录，在真实 390×844 与 320px viewport 验证 Preferences、Scan、Confirmation；保留真实四维 range、文件上传/识别/替换、材料 category/brand/ABV/confidence/confirmed/add/delete/guard；FixedActionBar 贴底且无水平溢出；reduced-motion media query 生效。
  - 结果：将 Prototype 的 paper/wine/cinnabar/green/gold tokens、Kai/Serif/Mono 字体角色、纸卡、背景装饰、Scan 场景和材料确认视觉整合进既有 Next.js 组件；保留 SessionShell、真实 API、`expectedVersion`、恢复与安全边界。修复 Task 1 Review 的三项旧 finding：Shell 成为 bottom reserve 唯一 owner，error recovery 不再错误保持 `aria-busy=true`，小号 accent text 改用深色语义 alias。
  - 风险：独立 Reviewer 尚未审查；未打包的霞鹜文楷继续依赖系统 fallback；build 保留既有 `UPLOAD_DIR` 动态文件追踪 warning；正式 Playwright E2E 仍由 Task 7 建立。Task 2–6 的业务行为未开始。
- 2026-08-29 | Task 2 | implementation commit pending independent Review（branch `task-2-recipe-swipe-deck`）
  - 验证：ranking 稳定性调查结论 STABLE——`rank-recipe-candidates` 输出的推荐第一名以 `recommendedRecipeId` 持久化，Repository 写入/读取保持 recipes 顺序，GET 返回原数组顺序；前端仅按 `recommendedRecipeId` 提位，不重新 sort。定向测试：`recipe-selection-screen.test.tsx` 7 passed（RED 曾 7 failed）、`tests/components/session` 7 passed、`pnpm typecheck` 通过。Hackathon Sprint Mode 下未运行全量 `pnpm test / lint / format:check / build / test:e2e`。
  - 结果：实现单卡 Swipe Deck——首屏显示 recommendation ranking #1，左滑/“不要这杯”仅推进本地 deck cursor（零 client 调用），右滑/“选这杯”调用现有 `selectRecipe`（复用 requestId/expectedVersion/409 recovery），WARN 未确认禁用选择，BLOCK 卡只展示审计摘要不入 deck，三张全拒绝显示禁用“换一批”入口（Task 2 不实现 regenerate）；移除 RecipeCard 旧 radio 选择，保留点击等价操作与 reduced-motion。
  - 风险：独立 Reviewer 尚未审查；全量门禁待统一执行；“换一批”按钮当前为禁用占位，真实 regenerate 属 Task 3；`session-shell.tsx` 无需修改。

## Decision log

按以下格式追加 Product Pivot 期间的真实决策：

```text
YYYY-MM-DD | 决策标题
背景：
选择：
替代方案：
后果：
```

已冻结：

- 2026-08-28 | 初次生成仍为三卡，Swipe 只是浏览
  - 背景：产品需要单卡手机交互，但后端已有稳定 A/B/C batch 合同。
  - 选择：每次初次生成或换批调用 `generate()` 返回恰好 A/B/C；前端逐张展示，右滑才选择。
  - 替代方案：每次左滑实时生成一张，或把 Provider 改成单候选返回；均不采用。
  - 后果：新 regenerate 必须是显式用户动作，且每批重新过 Zod、Safety 和 recommendation ranking。

- 2026-08-28 | 满意优先与可选 final drink
  - 背景：饮后反馈应先降低填写负担，满意用户不需要被迫进入调整表单。
  - 选择：Task 5 的“满意”只进入客户端 `satisfied-closing` phase；Task 6 接手并在 final drink 拍摄或跳过后保存 `accepted=true` 与 `finalImageId(uuid|null)`，再调用 `completeSession`；不满意才保存 `accepted=false` 并进入四维 Vn+1。
  - 替代方案：所有用户先填写四维反馈，或新增 FINAL_PHOTO 状态；均不采用。
  - 后果：现有 Feedback/Adjustment 后端复用，UI 需要清晰区分满意收尾、proposal 和 current recipe。

- 2026-08-28 | 旧 checkpoint 能力保留但退出新版 Mixing 主路径
  - 背景：旧 migration 和数据可能已存在，产品 Pivot 不应破坏历史数据。
  - 选择：保留旧字段、数据、route 和 migration；新版 Mixing Stepper 不要求或使用 checkpoint photo。
  - 替代方案：删除旧 migration 或将过程照继续设为必经节点；均不采用。
  - 后果：Task 4 只改 UI/主路径，旧数据兼容测试继续保留。

- 2026-08-28 | Regenerate API 待产品负责人决定
  - 背景：现有 `generateRecipeSet` 主要服务 READY 首次生成，RECIPE_SELECTION 换批需要新的业务语义。
  - 选择：Task 3 先比较扩展既有 POST 与新增 regenerate Route/use case；在用户决定前不实现任一方案。
  - 替代方案：Codex 直接选择一个 API 方案；不采用。
  - 后果：Task 3 是实现前的明确决策门，不能以 UI 细节绕过后端语义。

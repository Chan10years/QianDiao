# Task 13：成品反馈、单配方版本链与实验记忆实施计划

- 基线 worktree：`D:\CodeLibrary\FullStackDev\task-13-feedback-loop`
- 基线 branch：`codex/task-13-feedback-loop`
- 基线 commit：`9c0960b10ae97dcd085966d99ca800642c501aa0`
- 计划依据：`docs/superpowers/specs/2026-08-27-task-13-feedback-loop-design.md`
- 实施顺序：13A → 独立 Review → 13B → 独立 Review → 13C → Final Review

## 计划总约束

本计划只覆盖产品负责人批准的方案 1。V1 保持现有三配方集合；每个 V2/V3/Vn 是只含一个配方的新 recipe set。`parentRecipeId` 指向上一版本，`feedbackId` 指向产生调整的反馈。三卡 `getRecipeSet()` 和当前配方/版本链读取路径严格分离。

每项生产实现必须遵守 RED → GREEN：先在指定测试文件中写会失败的行为测试并运行，确认失败原因对应目标行为，再写最小实现使其通过。每个检查点只产生一个独立提交，提交后停止并交给全新的独立 Reviewer。实施期间不修改 `Task.md`，不合并回 `codex/integration-m3`，不推送远端，不创建额外 worktree，不并行修改共享代码。

全量门禁命令固定为：

```text
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

涉及数据库的检查点还必须从空数据库运行迁移，并在已有 `0000`–`0005` 数据库上运行升级迁移。任何失败都要保留完整错误和工作树状态，不能用修改配置或跳过测试掩盖。

## 13A：数据与版本链底座

### 范围

13A 只建立数据和读取底座，不实现 API Route、页面、SessionShell、实际 Provider 调用、Feedback/Adjustment/Complete 应用编排或 13B/13C 功能。

允许新增或修改的文件：

- 新增 `drizzle/0006_task_13_feedback_id.sql`：只增量增加 `recipes.feedback_id` 可空外键和所需索引；不得修改 `drizzle/0000_married_mongoose.sql` 至 `drizzle/0005_curved_blue_shield.sql`。
- 修改 `drizzle/meta/_journal.json`：只追加 0006 迁移记录。
- 新增 `drizzle/meta/0006_snapshot.json`：由现有 Drizzle 迁移生成方式产生。
- 修改 `src/infrastructure/db/schema.ts`：声明 `recipes.feedbackId` 和对应关系。
- 修改 `src/repositories/recipe-repository.ts`：扩展 `RecipeRecord`、`CreateRecipeInput`、单配方 set 写入及版本链读取接口。
- 修改 `src/infrastructure/repositories/drizzle-recipe-repository.ts`：实现 `feedbackId` 的 Zod/数据库映射、单配方 set 写入、当前配方读取和版本链读取。
- 修改 `src/application/get-recipe-set.ts`：让三卡读取固定使用初始三卡 set，继续执行恰好三卡和 A/B/C 校验，不读取调整 set。
- 新增 `src/application/get-current-recipe.ts`：实现 `getCurrentRecipe(sessionId)`。
- 新增 `src/application/get-recipe-version-chain.ts`：实现 `getRecipeVersionChain(recipeId)`。
- 新增 `src/agent/build-adjustment-constraints.ts`：实现无 IO 的 `buildAdjustmentConstraints(feedback)` 纯函数及其导出类型。
- 新增 `tests/unit/agent/build-adjustment-constraints.test.ts`：覆盖四个 delta 维度、边界值和 `alcoholIntensity=-2` 的实际动作语义。
- 新增 `tests/integration/repositories/task-13-recipe-version-chain.test.ts`：覆盖单配方 set、当前配方和 V1→V2→V3 链。
- 新增 `tests/integration/db/task-13-migration.test.ts`：覆盖全新数据库迁移和已有 0005 数据库升级。

不得在 13A 修改 `src/application/unit-of-work.ts`、`src/providers/recipe-provider.ts`、`src/infrastructure/providers/fallback-recipe-provider.ts`、`src/infrastructure/providers/qwen-recipe-provider.ts`、`src/infrastructure/http/envelopes.ts`、`src/infrastructure/http/session-client.ts`、`src/application/get-session.ts`、`components/` 或 `app/api/`。

### 输入接口和输出接口

输入来自当前已有模型和仓库：

- `RecipeCandidate`、现有 `RecipeWriteInput`/`CreateRecipeInput`、`recipeSets` 和 `sessions.selectedRecipeId`。
- `feedbackId` 是可空 UUID；现有 V1 写入 `NULL`。
- `buildAdjustmentConstraints` 输入已由 `FeedbackSchema` 校验的 `Feedback`。

底座必须提供以下可被 13B 使用的接口：

```ts
interface RecipeRecord {
  id: string;
  sessionId: string;
  recipeSetId: string;
  strategy: RecipeCandidate["strategy"];
  title: string;
  fitReason: string;
  differenceReason: string;
  materials: RecipeCandidate["materials"];
  steps: RecipeCandidate["steps"];
  estimatedAbv: number | null;
  safetyLevel: RecipeCandidate["safetyLevel"];
  experimental: boolean;
  missingIngredients: string[];
  version: number;
  parentRecipeId: string | null;
  feedbackId: string | null;
  createdAt: Date;
}

interface CreateSingleRecipeSetInput {
  recipeSet: CreateRecipeSetInput;
  recipe: CreateRecipeInput & {
    candidate: RecipeCandidate;
    version: number;
    parentRecipeId: string;
    feedbackId: string;
  };
}

interface RecipeRepository {
  createSingleRecipeSet(input: CreateSingleRecipeSetInput): RecipeRecord;
  findInitialRecipeSetBySession(sessionId: string): RecipeRecord[];
  findCurrentRecipeBySession(sessionId: string): RecipeRecord | null;
  listRecipeVersionChain(recipeId: string): RecipeRecord[];
}
```

`findInitialRecipeSetBySession` 的结果仍由 `getRecipeSet()` 做三卡契约校验；`findCurrentRecipeBySession` 返回 `sessions.selectedRecipeId` 指向的实际选中版本；`listRecipeVersionChain` 返回根到当前节点的顺序，并拒绝断链、回环、版本倒退或调整 set 多于一张配方。

`getCurrentRecipe` 输出当前 `VersionedRecipeReadModel`；`getRecipeVersionChain` 输出有序 `VersionedRecipeReadModel[]`。两个用例都返回 `recipeId`、`recipeSetId`、候选内容、`version`、`parentRecipeId`、`feedbackId` 和已持久化的 Safety 摘要，不调用三卡 `getRecipeSet()`。

`VersionedRecipeReadModel` 的候选内容使用现有 `RecipeCandidate`，Safety 展示使用现有 `RecipeSafetySummary`；读取层不得把 `SafetyDecision` 中的隐藏或内部字段直接发给客户端。

### RED → GREEN 顺序

1. 先在 `tests/unit/agent/build-adjustment-constraints.test.ts` 写失败测试：delta `-2..2` 全部可表达；`alcoholIntensity=-2` 必须产生 `REDUCE_SPIRIT_VOLUME` 和/或 `INCREASE_DILUTION`，不能只有文案；零值必须是 `KEEP`；甜度、酸度、酒精强度、酒体都必须有稳定映射。运行该单测并记录目标失败。
2. 先在 `tests/integration/db/task-13-migration.test.ts` 写失败测试：空库迁移后存在 `recipes.feedback_id`，旧 0005 数据升级后旧行可读且该列为 `NULL`，重复迁移不重复破坏数据。运行测试并记录目标失败。
3. 先在 `tests/integration/repositories/task-13-recipe-version-chain.test.ts` 写失败测试：V1 三卡保持原读取；V2/V3 各自 set 只有一张卡；`feedbackId`、`parentRecipeId`、version 正确；当前读取跟随 `selectedRecipeId`；完整链按 V1→V2→V3 返回。运行测试并记录目标失败。
4. 新增 0006 迁移和 schema 映射，运行空库/升级迁移测试使其通过。
5. 更新 `RecipeRecord`、`CreateRecipeInput` 和 Drizzle repository，先让 `feedbackId` round-trip 与单配方 set 测试通过，再实现当前配方和完整链读取。
6. 更新 `getRecipeSet()` 使用初始三卡查询，补充三卡读取不会把调整 set 当作三卡的失败测试并使其通过。
7. 运行 13A 目标测试、数据库迁移测试、`pnpm typecheck` 和格式检查；确认只改动允许文件。

### 13A 验收输出

- 增量 0006 迁移可在全新数据库执行，也可在 0005 数据库升级；0000–0005 文件无差异。
- V1 三卡读取契约保持不变；调整 set 的写入契约是恰好一张配方。
- 当前选中配方和完整版本链有独立读取用例，不经过 `getRecipeSet()`。
- 约束纯函数具有结构化动作，覆盖 `alcoholIntensity=-2` 的非文本语义。
- 目标测试、全量门禁和 Git diff 检查通过。
- 独立提交：`feat: establish task 13 recipe version foundation`。
- 提交后停止，交给 13A Review；不得进入 13B。

## 13B：后端反馈与调整闭环

### 范围

13B 在 13A Review 通过后开始，只实现后端反馈、调整、接受调整和完成闭环及四个 API Route，不实现 UI。

允许新增或修改的文件：

- 新增 `src/application/save-feedback.ts`。
- 新增 `src/application/generate-adjustment.ts`。
- 新增 `src/application/accept-adjustment.ts`。
- 新增 `src/application/complete-session.ts`。
- 修改 `src/application/unit-of-work.ts`：提供 Feedback、Recipe、Safety、Memory、Decision Event、Session 状态和幂等/租约的事务组合。
- 修改 `src/repositories/recipe-repository.ts` 和 `src/infrastructure/repositories/drizzle-recipe-repository.ts`：提供待确认调整、版本确认和实验记忆所需的读写接口。
- 修改 `src/providers/recipe-provider.ts`：锁定调整输入、单候选输出和约束传递接口。
- 修改 `src/infrastructure/providers/fallback-recipe-provider.ts`：将结构化 constraints 转换为真实材料/用量变化；不得把 delta 只拼到文字中。
- 修改 `src/infrastructure/providers/qwen-recipe-provider.ts`：传递调整约束并保留单候选、Zod 校验和 fallback 行为。
- 修改 `src/application/repair-blocked-recipe.ts`：复用确定性 ABV/Safety 重算路径，覆盖模型返回值。
- 修改 `src/workflow/session-machine.ts`：落实 `FEEDBACK → ADJUSTMENT → MIXING` 和满意 `FEEDBACK → COMPLETED` 的合法转换。
- 修改 `src/infrastructure/routes/recipe-route-dependencies.ts`：注入 Task 13 应用用例、Provider、仓库和事务依赖。
- 修改 `src/infrastructure/http/envelopes.ts`：为请求错误、非法状态、版本冲突、Provider 不可用和 Safety 阻断提供稳定错误映射。
- 新增 `app/api/sessions/[sessionId]/feedback/route.ts`。
- 新增 `app/api/sessions/[sessionId]/adjustments/route.ts`。
- 新增 `app/api/sessions/[sessionId]/accept-adjustment/route.ts`。
- 新增 `app/api/sessions/[sessionId]/complete/route.ts`。
- 新增 `tests/integration/application/feedback-adjustment.test.ts`。
- 新增 `tests/integration/api/task-13-feedback-routes.test.ts`。

不得在 13B 修改 `components/`、`src/infrastructure/http/session-client.ts`、`src/application/get-session.ts`、`components/session/session-shell.tsx` 或实现任何页面。

### 输入接口和输出接口

四个应用用例使用以下稳定接口：

```ts
interface SaveFeedbackInput {
  sessionId: string;
  requestId: string;
  expectedVersion: number;
  recipeId: string;
  feedback: Feedback;
}

interface SaveFeedbackResult {
  sessionId: string;
  state: "ADJUSTMENT" | "COMPLETED";
  sessionVersion: number;
  feedbackId: string;
  finalImageId: string | null;
}

interface GenerateAdjustmentInput {
  sessionId: string;
  requestId: string;
  expectedVersion: number;
  feedbackId: string;
}

interface GenerateAdjustmentResult {
  sessionId: string;
  state: "ADJUSTMENT";
  sessionVersion: number;
  currentRecipeId: string;
  proposedRecipe: VersionedRecipeReadModel;
  constraints: AdjustmentConstraints;
  safety: RecipeSafetySummary;
}

interface AcceptAdjustmentInput {
  sessionId: string;
  requestId: string;
  expectedVersion: number;
  proposedRecipeId: string;
}

interface AcceptAdjustmentResult {
  sessionId: string;
  state: "MIXING";
  sessionVersion: number;
  currentRecipeId: string;
}

interface CompleteSessionInput {
  sessionId: string;
  requestId: string;
  expectedVersion: number;
  feedbackId: string;
}

interface CompleteSessionResult {
  sessionId: string;
  state: "COMPLETED";
  sessionVersion: number;
  currentRecipeId: string;
}
```

Route 请求体必须用 Zod 校验并包含 `requestId`、`expectedVersion` 和对应业务字段：

- `POST /api/sessions/[sessionId]/feedback` 接收 `recipeId` 与 `feedback`，成功返回 `SaveFeedbackResult`。
- `POST /api/sessions/[sessionId]/adjustments` 接收 `feedbackId`，成功返回一个且仅一个 `proposedRecipe`；生成后 session 仍为 `ADJUSTMENT`，`selectedRecipeId` 和 `currentStep` 不变。
- `POST /api/sessions/[sessionId]/accept-adjustment` 接收 `proposedRecipeId`，成功返回 `AcceptAdjustmentResult`。服务端必须验证 session 处于 `ADJUSTMENT`、proposal 属于目标 session 的单配方调整 set、直接 parent/版本/feedback 链正确、proposal 已通过确定性 Safety，且 requestId/expectedVersion 有效；成功时原子更新 selected recipe、重置 currentStep 并进入 `MIXING`。该操作不调用 Provider、不重新生成配方。
- `POST /api/sessions/[sessionId]/complete` 接收 `feedbackId`，只完成合法满意路径并返回 `CompleteSessionResult`。

### RED → GREEN 顺序

1. 先在 `tests/integration/application/feedback-adjustment.test.ts` 写失败测试：不满意反馈进入 ADJUSTMENT；满意反馈进入 COMPLETED；反馈、可选 final image、memory 和 decision event 同事务提交。运行测试确认目标失败。
2. 增加失败测试：V1→F1→V2→F2→V3，每次调整 set 只有一张配方，Vn 的 parent/feedback 链正确，版本连续，调整 Provider 只被要求返回一个候选。运行测试确认目标失败。
3. 增加失败测试：模型返回的 Safety/ABV 被确定性结果覆盖；确定性 BLOCK 不会成为可选配方，并返回稳定 Safety 错误；安全 fallback 的 delta 会改变真实材料/用量。运行测试确认目标失败。
4. 增加失败测试：生成 V2 后 selected recipe 仍是 V1、session 仍为 `ADJUSTMENT`；接受 V2/V3 后 selected recipe、`currentStep`、state 和版本链正确；跨 session、非直接子版本、版本跳跃、旧版本、平行版本、错误 phase 和过期 version 都被拒绝。运行测试确认目标失败。
5. 增加失败测试：相同 requestId 重放不重复写入；过期 expectedVersion 返回 `VERSION_CONFLICT` 且无部分提交；并发请求只有一个写入成功；Provider 503 不写入半成品。运行测试确认目标失败。
6. 增加 `tests/integration/api/task-13-feedback-routes.test.ts` 失败测试：四个路由的 Zod 错误、404、非法状态、VERSION_CONFLICT、Provider 503、Safety 阻断和成功响应映射稳定。运行测试确认目标失败。
7. 实现 `save-feedback` 的事务组合和合法状态转换；实现 `generate-adjustment` 的请求租约/幂等、constraints、Provider 单候选、确定性 Safety 重审和单配方 set 写入；实现 `accept-adjustment` 的 proposal 校验、幂等并发和 `ADJUSTMENT → MIXING` 原子转换；实现 `complete-session` 的满意完成路径。
8. 接入 fallback/Qwen adjustment 和依赖工厂；四个 Route 只做解析、调用和错误映射，不直接访问 SQLite 或推进状态。
9. 运行应用与 API 集成测试，检查 memory 只作创意上下文、Safety 仍在其后执行，并完成 13B 全量门禁。

### 13B 验收输出

- `save-feedback`、`generate-adjustment`、`accept-adjustment`、`complete-session` 的输入/输出和错误码稳定。
- `accept-adjustment` 只接受当前链路中的唯一 proposal，成功后才更新 selected recipe 并进入 `MIXING`；生成调整本身保持 `ADJUSTMENT`。
- Feedback、Recipe、Safety、Memory、Decision Event 和状态变更按用例事务提交；没有半提交的可选版本。
- Provider 只生成一个调整候选，确定性 Safety 重新计算并覆盖模型 Safety/ABV。
- 幂等、expectedVersion、并发冲突、Provider 503、Safety BLOCK 都有集成证据。
- 后端完整覆盖 V1→V2→V3/Vn，且三卡 `getRecipeSet()` 没有被调整读取调用。
- 独立提交：`feat: add task 13 feedback adjustment backend`。
- 提交后停止，交给 13B Review；不得进入 13C。

## 13C：用户界面与端到端闭环

### 范围

13C 在 13B Review 通过后开始，实现客户端上传、snapshot、反馈/调整/完成页面、客户端操作协议和真实移动端流程。

允许新增或修改的文件：

- 修改 `src/application/get-session.ts`：扩展 snapshot，包含当前选中配方、待确认调整、版本链、反馈摘要和 Safety 摘要；不把数据库对象直接暴露给客户端。
- 修改 `src/infrastructure/http/session-client.ts`：扩展 `SessionClientLike`、mutation 名称和 `requestId` 操作，包括 `saveFeedback`、`generateAdjustment`、`completeSession`、`uploadFinalDrinkImage`。
- 修改 `src/application/upload-session-image.ts`：保持 `final_drink` 可选并将上传结果安全映射为反馈图片 ID。
- 修改 `components/session/session-shell.tsx`：为 FEEDBACK、ADJUSTMENT、COMPLETED 读取独立 snapshot/版本链，并支持刷新恢复和冲突刷新。
- 新增 `components/feedback/feedback-screen.tsx`。
- 新增 `components/feedback/delta-control.tsx`。
- 新增 `components/adjustment/adjustment-screen.tsx`。
- 新增 `components/completed/completed-screen.tsx`。
- 新增 `tests/components/feedback/feedback-screen.test.tsx`。
- 新增 `tests/components/feedback/delta-control.test.tsx`。
- 新增 `tests/components/adjustment/adjustment-screen.test.tsx`。
- 新增 `tests/components/completed/completed-screen.test.tsx`。
- 修改 `tests/components/preferences/session-client.test.ts`：覆盖 Task 13 client contract 和 requestId。
- 修改 `tests/components/preferences/session-shell.test.tsx`：覆盖 snapshot 刷新和状态恢复。
- 新增 `tests/e2e/task-13-feedback-loop.spec.ts`：覆盖移动端 Chromium 完整路径。

不得在 13C 引入 React 以外的新前端框架、账户、云存储、队列或新的生产依赖。

### 输入接口和输出接口

Session snapshot 至少增加以下客户端安全 DTO：

```ts
interface RecipeVersionSnapshot {
  recipeId: string;
  recipeSetId: string;
  recipe: RecipeCandidate;
  version: number;
  parentRecipeId: string | null;
  feedbackId: string | null;
  safety: RecipeSafetySummary;
}

interface SessionSnapshot {
  id: string;
  state: SessionState;
  version: number;
  selectedRecipeId: string | null;
  currentRecipe: RecipeVersionSnapshot | null;
  proposedAdjustment: RecipeVersionSnapshot | null;
  versionChain: readonly RecipeVersionSnapshot[];
  feedback: readonly FeedbackSummary[];
}

interface FeedbackSummary {
  id: string;
  recipeId: string;
  rating: number;
  accepted: boolean;
  deltas: FeedbackDeltas;
  notes: string | null;
  finalImageId: string | null;
}
```

`SessionClientLike` 的 Task 13 操作必须接收当前 snapshot 的 `expectedVersion`，并为一次逻辑操作生成或复用 `requestId`。客户端方法输出后端 DTO，不返回数据库连接、隐藏推理或未过滤 Provider 原始 JSON。

页面行为固定为：

- FEEDBACK：rating、accepted、四个 `-2..2` delta、最多 2000 字符 notes 和可选 final_drink 上传；满意提交直接进入 COMPLETED，不满意提交进入 ADJUSTMENT。
- ADJUSTMENT：展示当前版本、唯一待确认版本、版本变化、用量/ABV/Safety 摘要；用户点击“按这个继续调”后调用 `accept-adjustment` 进入 MIXING，调制完成后回到 FEEDBACK，可继续生成下一版本。M2 原有首次选择配方接口和 V1 三卡读取保持冻结。
- COMPLETED：展示当前配方、V1→Vn 轨迹、反馈摘要和 Safety 摘要，不展示隐藏推理。

### RED → GREEN 顺序

1. 先写 `tests/components/feedback/feedback-screen.test.tsx` 和 `tests/components/feedback/delta-control.test.tsx` 失败测试：四个 delta 只能取 `-2..2`，notes 上限，rating/accepted 校验，final image 可选。运行测试确认目标失败。
2. 先写 `tests/components/adjustment/adjustment-screen.test.tsx` 和 `tests/components/completed/completed-screen.test.tsx` 失败测试：只显示一个待调整方案、显示 parent/version/Safety、接受后进入 MIXING、完成页显示轨迹且不显示隐藏推理。运行测试确认目标失败。
3. 先修改 `tests/components/preferences/session-client.test.ts` 和 `tests/components/preferences/session-shell.test.tsx` 写失败测试：每个变更带 requestId/expectedVersion，刷新从 snapshot 恢复当前和待确认版本，FEEDBACK/ADJUSTMENT/COMPLETED 不调用三卡调整读取。运行测试确认目标失败。
4. 先写 `tests/e2e/task-13-feedback-loop.spec.ts` 失败流程：移动端 Chromium 完成 V1→反馈→V2→再反馈→V3→满意→COMPLETED，并覆盖上传失败、Provider 503、VERSION_CONFLICT 和刷新恢复。运行测试确认目标失败。
5. 实现 DTO/snapshot 和 SessionClientLike；实现 final_drink 客户端上传，上传失败时保留反馈表单并允许不带图片继续。
6. 实现三个页面和 SessionShell 状态分支。Provider 503 显示可重试且不假装生成成功；VERSION_CONFLICT 重新获取 snapshot、停止旧操作并提示用户基于新版本操作；刷新按服务端状态恢复。
7. 运行组件测试和真实移动端 Chromium E2E；确认 Vn 读取始终使用单配方当前/版本链路径。
8. 运行 13C 全量门禁并在提交前复核 worktree、branch、HEAD、status、变更文件和浏览器流程证据。

### 13C 验收输出

- final_drink 可选，上传失败可恢复，不阻塞反馈提交。
- FEEDBACK、ADJUSTMENT、COMPLETED 三个页面与服务端状态、版本链和 Safety 摘要一致。
- requestId、expectedVersion、刷新恢复、Provider 503 和 VERSION_CONFLICT 具有精确行为测试。
- 移动端 Chromium 真实完成 V1→反馈→V2→再反馈→V3→满意→COMPLETED。
- 独立提交：`feat: complete task 13 feedback loop ui`。
- 提交后停止，交给 Final Review。

## 串行 Review 和交付协议

13A、13B、13C 的实施者必须在各自阶段提交后停止。Reviewer 必须是独立对话，采用只读方式检查真实 diff、提交内容、测试输出、数据库迁移、错误恢复和范围边界。

- 13A Review 失败：只将明确的 Critical/Important 证据返回 13A 实施者；未通过前不开始 13B。
- 13B Review 失败：只将明确的 Critical/Important 证据返回 13B 实施者；未通过前不开始 13C。
- Final Review 失败：补充最小失败测试和修复，重新运行全量门禁与真实移动端流程，再给出最终结论。

任何阶段都不得以通过 broad test 代替迁移、幂等、事务、Safety、Provider 失败、持久化恢复或浏览器流程证据。计划完成时不改变产品范围，不引入账户、云存储、队列、后台统计或新的前端技术栈。

## 冻结收口（2026-08-28）

- Task 13A 数据与版本链底座已完成并通过独立审查；Task 13B 后端反馈调整闭环已完成并通过独立审查。
- Reviewer 首轮发现的 4 个 Important 已由提交 `64f45e8f6596f71628a34d52b9fbc7e26d13a482` 修复，并通过聚焦复审。
- 原计划中的旧 Task 13C 已由产品负责人取消/废止，不再实现；不得勾选或宣称旧 13C 已完成。
- 当前冻结的是可复用的后端基线，不得表述为旧版完整 UI 已完成。Swipe、三张拒绝后换一批、Mixing redesign 和新 Final Photo UI 均未在本仓库实现。
- 后续 Product Pivot 将在独立新项目中重新规划；这里只记录范围收口，不写其详细实现。
- 仓库没有可执行 E2E 测试文件，这是已知验证缺口；`pnpm test:e2e` 的 `No tests found` 应如实记录，不能伪装为通过。

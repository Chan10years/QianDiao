# Task 13：成品反馈、单配方版本链与实验记忆设计

- 状态：产品负责人已批准，作为 Task 13 实施真相源
- 日期：2026-08-27
- 实施基线：`codex/task-13-feedback-loop`，`9c0960b10ae97dcd085966d99ca800642c501aa0`
- 目标：在现有 M3 调饮流程上增加可追溯的反馈、单配方调整版本和完成态闭环

## 1. 范围与不变量

Task 13 只处理一次调饮会话从成品反馈到调整版本再回到调制的闭环。现有会话、配方生成、确定性 Safety、三卡选择和分步调制能力继续作为基础能力使用。

以下规则是实现不可变更的产品和架构约束：

1. 初始 V1 继续使用现有的三配方集合，保留 A/B/C 三种策略和现有 `getRecipeSet()` 三卡读取契约。
2. 每次不满意反馈只生成一个调整方案。V2、V3、V4 以及后续 Vn 各自写入一个只包含一张配方卡的新 recipe set。
3. 每个调整配方通过 `parentRecipeId` 指向被用户实际调制的上一版本，通过 `feedbackId` 指向生成本次调整的反馈。
4. 调整版本使用独立的当前配方和版本链读取路径，绝不通过要求恰好三张卡的 `getRecipeSet()` 读取。
5. 每一轮调整都重新执行确定性 Safety。模型返回的 Safety 级别和 ABV 只是候选输入，不能覆盖确定性计算结果。
6. `final_drink` 图片是可选输入；上传失败不得阻止用户在没有成品照的情况下完成反馈。
7. 用户满意时进入 `COMPLETED`；不满意时进入 `ADJUSTMENT`，生成一个新版本后接受该版本进入 `MIXING`。
8. 针对已有会话的变更都使用 `requestId` 幂等和 `expectedVersion` 乐观并发控制，并在单个数据库事务中提交相关状态和审计记录。

账户、多用户、云存储、队列、后台统计、RAG、向量数据库、硬件控制和新的前端框架不属于本设计。

## 2. 数据模型和版本链

`recipes` 增加可空的 `feedback_id` 外键列，保持已发布的 `0000`–`0005` 迁移不变。现有 `version` 和 `parent_recipe_id` 字段继续用于版本关系。

关系语义如下：

- `feedback.recipe_id` 是用户实际品尝并评价的配方。
- `recipes.feedback_id` 是创建该调整配方的反馈；初始 V1 为 `NULL`。
- `recipes.parent_recipe_id` 是该配方的上一版本；V1 为 `NULL`。
- `sessions.selected_recipe_id` 表示用户当前选中的实际配方。生成调整期间，待确认的 Vn 不替换该值；用户接受 Vn 后才更新它。
- `proposedRecipe` 表示由当前已接受配方和本轮反馈生成、尚未被用户接受的唯一调整版本；`currentRecipe` 表示 `sessions.selected_recipe_id` 指向的已接受配方。二者必须在读取模型和 API 响应中明确区分。
- `experiment_memories` 只保存 `recipeId`、`feedbackId`、外显摘要和结构化 tags，不保存隐藏思维链、完整 Prompt 或图片二进制。

以三轮反馈为例，持久化关系必须是：

| 版本 | recipe set | 配方数量 | `parentRecipeId` | `feedbackId` | 反馈记录           |
| ---- | ---------- | -------: | ---------------- | ------------ | ------------------ |
| V1   | 初始 set   |        3 | `NULL`           | `NULL`       | `F1.recipeId = R1` |
| V2   | 调整 set 2 |        1 | `R1`             | `F1`         | `F2.recipeId = R2` |
| V3   | 调整 set 3 |        1 | `R2`             | `F2`         | `F3.recipeId = R3` |

因此从当前 R3 反向追溯再反转即可得到 `V1 → V2 → V3`。版本链读取必须校验父子关系、版本号递增、反馈指向和每个调整 set 恰好一张配方；异常数据以稳定错误返回，不拼装成可选配方。

## 3. 读取路径严格分离

### 三卡读取

`src/application/get-recipe-set.ts` 继续服务初始三卡选择。它只读取初始 recipe set，保留恰好三张卡和 A/B/C 策略校验，并继续重新执行确定性 Safety 和既有决策审计。它不能把最新的单配方调整 set 当作三卡集合返回。

### 当前配方读取

`src/application/get-current-recipe.ts` 提供 `getCurrentRecipe(sessionId)`，沿 `sessions.selected_recipe_id` 读取用户当前选中的配方，并返回包含以下元数据的 `VersionedRecipeReadModel`：

- `recipeId`、`recipeSetId`、候选配方内容；
- `version`、`parentRecipeId`、`feedbackId`；
- 确定性 Safety 摘要和当前选择状态。

### 完整版本链读取

`src/application/get-recipe-version-chain.ts` 提供 `getRecipeVersionChain(recipeId)`，返回从 V1 到当前节点的有序 `VersionedRecipeReadModel[]`。该读取路径可以被反馈、调整和完成页面使用，但不调用 `getRecipeSet()`。

生成调整后的待确认配方读取由后端在同一版本链底座上提供，待确认版本和已选中版本必须在响应中明确区分，避免 UI 把尚未接受的 Vn 当成当前配方。

## 4. 反馈循环和状态机

正常循环为：

```text
MIXING 完成
    ↓
FEEDBACK
    ├─ accepted=true  ───────────────→ COMPLETED
    └─ accepted=false → ADJUSTMENT → MIXING
                              ↑         │
                              └─────────┘
```

具体行为：

1. `MIXING` 的最后一步完成后，现有状态机进入 `FEEDBACK`，当前选中配方仍是刚刚调制的版本。
2. `save-feedback` 校验 `FeedbackSchema`。满意反馈在事务中记录反馈、可选 `finalImageId`、实验记忆和决策事件，并通过合法状态转换进入 `COMPLETED`。
3. 不满意反馈在事务中记录同样的反馈、记忆和事件，并进入 `ADJUSTMENT`。此时不创建第二张配方卡，也不改变当前已选配方。
4. `generate-adjustment` 读取当前配方、该配方的最新反馈、已确认原料和可用实验记忆，调用 `RecipeProvider.adjust`，只接受一个 `RecipeCandidate`。
5. 候选通过 Zod 后，应用层用 `buildAdjustmentConstraints` 约束反馈含义，并重新计算 ABV 与确定性 Safety。Safety `BLOCK` 的候选不可写成可选择的版本；若安全 fallback 也不能满足规则，保持 `ADJUSTMENT` 并返回稳定错误。
6. 安全候选在事务中写入一个新 recipe set 和一个新 recipe，版本号递增，`parentRecipeId` 指向当前配方，`feedbackId` 指向本轮反馈，同时记录 Safety 与决策事件。会话仍停留在 `ADJUSTMENT`，等待用户确认。
7. `generate-adjustment` 只返回唯一的 `proposedRecipe`，不得更新 `selectedRecipeId`、`currentStep` 或把会话推进到 `MIXING`。已有待确认 proposal 时，不得通过不同 `requestId` 无限生成平行版本；相同请求重放只返回原结果。
8. `POST /api/sessions/{sessionId}/accept-adjustment` 接收 `{ requestId, expectedVersion, proposedRecipeId }`。它只允许 `ADJUSTMENT` 会话接受属于该 session 的唯一单配方调整 set，并验证 proposal 的 `parentRecipeId` 是当前 selected recipe、版本是当前版本加一、`feedbackId` 属于同一 session 且对应本轮反馈，且 proposal 已完成确定性 Safety 裁决。通过后在一个事务中更新 `selectedRecipeId`、将 `currentStep` 重置为 0、递增 session version，并通过合法状态转换进入 `MIXING`。接受动作不调用 Provider、不重新生成配方；重复 requestId 返回相同结果，并发请求只有一个成功。
9. 用户接受 Vn 后，事务更新 `selectedRecipeId`、清理当前调制步骤并进入 `MIXING`。调制完成后再次进入 `FEEDBACK`，可以生成 Vn+1。

`complete-session` 只允许合法的满意路径完成会话；路由不能通过直接传入状态值绕过状态机、反馈或 Safety。

## 5. 调整约束和 Safety

`src/agent/build-adjustment-constraints.ts` 是无 IO 的纯函数。它接收已通过 `FeedbackSchema` 的反馈，返回结构化 `AdjustmentConstraints`：

```ts
type AdjustmentDimension = "sweetness" | "acidity" | "alcoholIntensity" | "body";
type AdjustmentAction =
  | "KEEP"
  | "INCREASE_SWEETENER"
  | "REDUCE_SWEETENER"
  | "INCREASE_ACID_COMPONENT"
  | "REDUCE_ACID_COMPONENT"
  | "INCREASE_SPIRIT_VOLUME"
  | "REDUCE_SPIRIT_VOLUME"
  | "INCREASE_DILUTION"
  | "INCREASE_BODY_SUPPORT"
  | "REDUCE_BODY_SUPPORT";

interface AdjustmentConstraint {
  dimension: AdjustmentDimension;
  delta: -2 | -1 | 0 | 1 | 2;
  actions: readonly AdjustmentAction[];
  magnitude: 0 | 1 | 2;
}

interface AdjustmentConstraints {
  constraints: readonly AdjustmentConstraint[];
}
```

至少应保证以下语义：`alcoholIntensity = -2` 返回降低酒基体积和/或增加稀释的结构化动作，不能只在文案中写“降低酒精”；零值返回 `KEEP`；其他三个维度也必须能被 Provider 或 fallback 转换为实际材料/用量变化。纯函数不访问数据库、Provider、时间、随机数或文件系统。

每次调整的安全顺序固定为：输入 Zod 校验 → 约束构建 → Provider 候选 → 候选 Zod 校验 → 确定性 ABV/Safety 重算 → 持久化安全结果。模型 Safety 和模型 ABV 不能成为最终值。

## 6. 事务、幂等、并发和刷新恢复

每个会话变更包含 `requestId` 和 `expectedVersion`。同一 `requestId` 的重试返回第一次已提交的结果，不重复写反馈、配方、记忆或决策事件。相同会话的旧 `expectedVersion` 返回 `VERSION_CONFLICT`，不部分提交。

Provider 调用属于外部 IO，不能把数据库事务保持在远程调用期间。应用层先在短事务中取得并锁定/租约化当前会话版本和请求幂等记录，完成 Provider 与确定性 Safety 后，再以一个事务写入最终的反馈/配方/安全记录、实验记忆、决策事件和状态变化；并发请求只能有一个成功提交。

客户端每个操作都从当前 snapshot 取得 `expectedVersion` 并生成或复用该逻辑操作的 `requestId`。刷新通过 session snapshot 和独立的当前配方/版本链读取恢复，不依赖 React 内存状态。Provider 503 保留可重试状态；`VERSION_CONFLICT` 先重新读取 snapshot，再要求用户基于新版本重新操作。

## 7. 实验记忆和外显信息

反馈保存的实验记忆只能包含配方 ID、反馈 ID、简短外显总结和 tags。下一轮 Provider 可以把这些信息作为创意上下文，但必须再次经过 Zod 和确定性 Safety。记忆永远不能降低 Safety 级别、跳过 ABV 确认、绕过 `BLOCK` 或直接推进状态。

页面只展示配方变化、版本轨迹、Safety 摘要、规则 ID/原因/替代建议和用户可见错误，不展示隐藏推理、完整 Prompt 或敏感运行信息。

## 8. 三个串行实施检查点

实施严格按以下顺序进行：

1. **13A：数据与版本链底座**：迁移、`feedback_id`、单配方 set 写入/读取、当前配方读取、完整链读取和纯约束函数；不实现 API、页面、实际 Provider 调用或 SessionShell。
2. **13A Review**：独立 Reviewer 只读检查数据完整性、迁移兼容性、读取契约、测试证据和范围边界。未通过不得进入 13B。
3. **13B：后端反馈与调整闭环**：四个应用用例、事务、Provider adjust、确定性 Safety、幂等并发、四个 Route 和后端集成测试；不实现 UI。
4. **13B Review**：独立 Reviewer 检查状态、事务、错误恢复、Safety 覆盖和 V1→Vn 集成证据。未通过不得进入 13C。
5. **13C：用户界面与端到端闭环**：final_drink 客户端上传、snapshot、三个页面、SessionClientLike、错误恢复、刷新恢复和移动端 Chromium 流程。ADJUSTMENT 页面展示唯一 proposal，并提供“按这个继续调”按钮调用 `accept-adjustment`；M2 原有首次选择配方接口保持冻结。
6. **Final Review**：独立 Reviewer 检查完整验收、全量门禁、实际浏览器路径、状态和工作树证据。

三个检查点必须串行执行，不使用多个 Agent 并行修改共享代码；每项生产实现前先写并运行目标失败测试；每个检查点独立提交，完成后停止交给独立 Reviewer。

## 9. 冻结收口（2026-08-28）

- Task 13A 数据与版本链底座已完成并通过独立审查；Task 13B 后端反馈调整闭环已完成并通过独立审查。
- Reviewer 首轮发现的 4 个 Important 已由提交 `64f45e8f6596f71628a34d52b9fbc7e26d13a482` 修复，并通过聚焦复审。
- 原计划中的旧 Task 13C 已由产品负责人取消/废止，不再实现；本节不勾选、不宣称旧 13C 已完成。
- 当前冻结的是可复用的后端基线，不得表述为旧版完整 UI 已完成。Swipe、三张拒绝后换一批、Mixing redesign 和新 Final Photo UI 均未在本仓库实现。
- 后续 Product Pivot 将在独立新项目中重新规划；本节不描述其详细实现。
- 仓库没有可执行 E2E 测试文件，这是已知验证缺口；`pnpm test:e2e` 的 `No tests found` 应如实记录，不能伪装为通过。

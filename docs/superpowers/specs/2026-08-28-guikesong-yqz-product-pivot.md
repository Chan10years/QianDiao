# Guikesong YQZ Product Pivot Spec

- 状态：当前仓库产品交互与 MVP 范围的最高真相源
- 日期：2026-08-28
- 适用范围：从冻结后端基线继续演进的手机优先、本地运行 Demo
- 维护规则：Product Pivot 的交互、状态语义或范围改变时，先更新本文，再更新 `AGENTS.md`、`PRODUCTION.md` 和 `Task.md`

本文采用“继承 + 覆盖”，不复制旧架构规格。未在本文覆盖的后端、安全、Zod、Provider、数据库、幂等、并发和运行约束继续继承：

- `docs/superpowers/specs/2026-08-21-baijiu-cocktail-agent-design.md`
- `docs/superpowers/specs/2026-08-27-task-13-feedback-loop-design.md`

## 1. Goal

把冻结基线中的后端闭环改造成更清晰的单卡手机体验：用户先确认桌面材料，系统每批生成恰好三套 A/B/C，经 Zod 和确定性 Safety 裁决后按推荐排序逐张浏览；用户右滑接受，或在三张都不喜欢时主动换一批。接受后以可恢复的 Mixing Stepper 完成调制，再用满意优先的反馈收尾：满意即可选择拍摄或跳过成品照并完成；不满意才进入四维调整，生成并接受一个新的 Vn+1。

本轮 Product Pivot 是交互和 MVP 范围重构，不是后端架构重写。当前目标是锁定后续 Task 1–8 的产品边界，避免把 Swipe、换批和满意优先反馈误实现成每次单候选生成或饮后拒绝调查。

## 2. Frozen baseline / inherited architecture

### 2.1 基线身份

- 旧工程冻结来源：`FROZEN_BASELINE_SHA=815add106fdd196c805cc2cc71941455241f0bfb`。
- 新仓库 baseline commit：`b27c353f71fd7f411697cd659c20face56c63bad`。
- 本仓库重新初始化 Git；旧来源 SHA 不要求存在于新仓库对象库中。
- Product Pivot 从该新仓库 baseline 开始；本 Spec 不批准任何本轮生产代码改动。

### 2.2 继承而不重写的能力

以下能力继续有效，除非本 Spec 明确覆盖其用户体验：

- M1：Session 聚合、SQLite/Drizzle、Repository、基础状态机、事务、`requestId` 幂等和 `expectedVersion` 乐观并发。
- M2：图片安全上传与标准化、Vision Provider、材料识别和人工确认、ABV Guard、`RecipeProvider.generate()`、初次 `RecipeCandidateSet` 的 A/B/C Zod 合同、确定性 Safety、BLOCK repair/fallback replace、推荐排序、Recipe Set 持久化和 `selectRecipe`。
- Task 13A/13B：Feedback 数据结构、V1 → V2 → V3 → Vn 版本链、`saveFeedback`、`generateAdjustment`、`acceptAdjustment`、`completeSession`、Adjustment Safety、幂等/并发/事务。
- 依赖方向、服务端密钥边界、上传防线、日志和审计约束、Provider 降级策略和迁移只前进规则继续继承旧 Spec。

当前保留但不代表新版 UI 必须使用的能力：旧 checkpoint photo 的数据、上传 Handler、数据库字段和已发布 migration。旧 migration 不删除、不回写、不重排。

## 3. New end-to-end product flow

```text
口味偏好
  ↓
拍摄桌面材料
  ↓
AI 识别
  ↓
用户人工确认 / 修正 / 必要时补拍
  ↓
后台一次生成恰好 3 个 A/B/C Recipe Candidate
  ↓
Zod
  ↓
deterministic Safety
  ↓
推荐排序
  ↓
前端一次只展示 1 张 Recipe Card
  ↓
左滑 = 不喜欢当前候选；右滑 = 接受当前候选
  ├─ 右滑 → 选为 V1 → MIXING
  └─ 连续左滑三张 → 显示“换一批” → 用户主动点击 → 新的 3 个 A/B/C
                                      ↓
                                重新 Zod + Safety + 推荐
  ↓
MIXING Stepper：currentStep、前进、后退、刷新恢复
  ↓
调制完成 → FEEDBACK
  ↓
先问“满意吗？”
  ├─ 满意 → 邀请拍 final drink（可拍 / 可跳过）→ COMPLETED
  └─ 还想调整 → 展开四维相对反馈和可选备注 → 生成 Vn+1
                                      ↓
                                用户接受 → MIXING
                                      ↓
                                再次询问满意与否
```

材料识别仍然遵循“模型负责猜、用户负责确认、规则决定能否使用”。涉及酒类但 ABV 未确认时，不能生成可选配方。所有候选在进入可选择 UI 前必须完成同一 Zod 和 deterministic Safety 管线。

## 4. Recipe batch + Swipe semantics

### 4.1 Batch contract

每次初次生成或换一批都调用 `generate()`，并且一次返回恰好三套：

```text
RecipeCandidateSet = {
  recipes: [A_CONSERVATIVE, B_CREATIVE, C_UPGRADE],
  recommendedRecipeId
}
```

三套必须是安全有效、可执行且有实质差异的候选。`BLOCK` 候选必须经过既有 repair 或 fallback replace，不能占用可选卡位。每批生成完成后，保存候选、Safety 决策、推荐信息、来源/降级信息和决策摘要。

Swipe 不改变 Provider 合同：不能把 Provider 改成每次只生成一张，也不能因为一次左滑就调用模型。每批的三张候选是后端事实，UI 只是逐张消费这批事实。

### 4.2 Card presentation

- 前端一次只展示一张 Recipe Card。
- 第一张是 recommendation ranking 的第一名，通常也是 `recommendedRecipeId` 对应的方案，但 UI 不依赖 A/B/C 的固定顺序。
- 每张卡保留既有可解释信息：策略、标题、适配原因、材料、用量、步骤、预计 ABV、差异、安全状态、实验性标记和缺失材料。
- `WARN` 必须显示原因并要求显式确认；`BLOCK` 只保留审计摘要，不进入可选择卡。
- 卡片通过触控和键盘可操作；除滑动手势外应提供清晰的“不要这杯/接受这杯”等可访问操作。

### 4.3 Swipe meaning

- 左滑只表示“当前候选不喜欢”，在本批内移动到下一张。
- 左滑不写 `Feedback`，不发送“饮后接受/拒绝”，不改变 `selectedRecipeId`，不推进到 `MIXING`，不产生后端 Safety 或 Provider 副作用。
- 右滑表示接受当前候选，调用既有选择能力（包含 `requestId`、`expectedVersion` 和必要的 `WARN` 确认），成功后进入 `MIXING` 并将其作为当前 V1。
- 网络失败或版本冲突时，UI 保留可恢复的动作状态，重新读取 session snapshot；不能把一次未确认的右滑当作已接受。

## 5. Recommendation ordering

排序由后端的 deterministic recommendation ranking 决定，并在 Recipe Set 读取模型中稳定表达。前端只按服务端顺序展示，不重新用 A/B/C 排序。

同一批的排序规则为：

1. 只允许 `ALLOW/WARN` 的候选进入可选序列；`BLOCK` 进入审计序列。
2. 使用既有 recommendation ranking 的分数和理由，推荐候选优先。
3. 分数相同时使用稳定 tie-breaker（持久化候选顺序或 recipe ID），不得使用随机顺序。
4. 首张必须是排序第一名；`recommendedRecipeId` 必须属于三张候选，并与推荐说明一致。

Task 2 必须用组件测试证明：UI 不会把数组重新排序为 A → B → C；Task 3 的新批次也必须重新执行同一排序。

## 6. Reject-all / regenerate semantics

连续左滑本批三张候选后，UI 显示明确的“换一批”入口。只有用户主动点击该入口，才允许产生一次新的生成操作。

换一批必须：

- 在当前会话仍处于 `RECIPE_SELECTION` 时发生，不新增 `FINAL_PHOTO` 或其他产品状态。
- 带有新的逻辑 `requestId` 和当前 `expectedVersion`，接受重复请求重放而不重复写入。
- 再次调用初次 `generate()`，返回恰好三套新的 A/B/C。
- 对新候选重新执行 Zod、确定性 Safety、BLOCK repair/fallback replace 和 recommendation ranking。
- 成功后重置单卡 deck 到新批次的第一名，并继续停留在 `RECIPE_SELECTION`，直到用户右滑选择。
- 失败时保留当前会话和上一批可审计数据，给出可重试错误；不得自动循环调用 Provider，也不得把失败伪装成成功。

换一批的 HTTP/API 形态是实现阶段的待决策项。Task 3 必须先调查现有 `generateRecipeSet`、`POST /api/sessions/{sessionId}/recipes`、Recipe Set Repository 和幂等/版本约束；如果选择“扩展既有 POST”或“新增独立 regenerate 用例/Route”均需在 Decision Log 写清取舍，并由产品负责人确认后实施。

## 7. Mixing Stepper

右滑接受后进入 `MIXING`。新版 UI 用纵向 Step Index/Stepper 表达全流程：顶部或侧边显示步骤序号，主内容只展示当前步骤的 instruction、相关用量和当前动作。

必须保留：

- 服务端持久化的 `currentStep`。
- 前进、后退的边界和合法状态机转换。
- 刷新后从 session snapshot 恢复当前步骤和当前配方。
- 最后一步完成后进入 `FEEDBACK`。
- 失败、版本冲突和网络丢失时不在客户端偷偷推进步骤。

新版 UI 不要求、不主动展示或上传 Mixing checkpoint photo。旧 checkpoint photo 能力可继续存在，旧数据和 migration 不删除；它们不是新版 Mixing 的必经条件，也不应阻止完成步骤。

## 8. Satisfaction-first Feedback

调制完成后进入 `FEEDBACK`，第一屏只问：

> 满意吗？

提供两个清晰选项：

- **满意**：进入 final drink 收尾。
- **还想调整**：才展开详细反馈表单。

用户没有选择“还想调整”前，不展示甜度、酸度、酒感、浓郁度的调整滑杆或“拒绝原因”调查。

“还想调整”表单复用已有 `Feedback` 后端合同：四个维度使用 `-2..+2` 相对变化，可选填写备注，提交后由已有 `saveFeedback` 保存当前实际品尝配方的反馈并进入 `ADJUSTMENT`。本 Product Pivot 不新增“三张全部拒绝后的拒绝原因”调查。

满意路径也复用既有 Feedback/complete 能力，但必须将 `accepted=true` 与可选 `finalImageId` 一起保存，最终合法进入 `COMPLETED`。完成动作仍受状态机、Safety、幂等和并发规则保护，不能由客户端直接写状态字符串。

## 9. Vn adjustment loop

不满意反馈后，后台对当前已接受配方生成一个且仅一个下一版本 `Vn+1`：

```text
当前已接受 Vn + 本轮 Feedback
  → buildAdjustmentConstraints
  → RecipeProvider.adjust()
  → Candidate Zod
  → deterministic ABV/Safety
  → 持久化 proposal Vn+1
  → 用户接受
  → MIXING（currentStep 重置为 0）
```

必须继承 Task 13A/13B 的语义：

- `parentRecipeId` 指向实际被用户调制和评价的上一版本。
- `feedbackId` 指向产生本轮调整的反馈。
- proposal 在用户接受前不替换 `selectedRecipeId`，不推进到 `MIXING`。
- 候选只能在通过 Zod、ABV 和 deterministic Safety 后成为可接受的版本；`BLOCK` 无绕过路径。
- 用户接受 Vn+1 后重新进入 `MIXING`，完成后再次先问满意与否，可持续到 Vn+N。
- `requestId`、`expectedVersion`、事务提交、Provider lease/idempotency 和错误恢复继续使用继承后端合同。

每次调整只生成一个当前配方的下一版本，不生成第二组三卡，也不把 Swipe 的左滑记录伪装成 Feedback。

## 10. Final drink optional photo

final drink 是 `FEEDBACK` 收尾阶段的可选图片，图片角色继续使用既有 `final_drink` 语义，不新增 SessionState。

- 满意后邀请用户拍摄 final drink；用户可以拍摄，也可以明确点击跳过。
- 上传成功时，满意 Feedback 关联 `finalImageId`。
- 上传失败时显示可重试和“跳过 final drink”；跳过不会阻止满意 Feedback 保存或 `COMPLETED`。
- 不满意路径也可以按继承后端允许的方式保存可选 final image，但它不是进入调整的前置条件。
- final drink 只作为实验上下文，不用于自动判定质量、医学结论或 Safety override。

## 11. State semantics

只使用继承的合法状态：

```text
PREFERENCES → SCAN → CONFIRM → READY → RECIPE_SELECTION
RECIPE_SELECTION → MIXING
MIXING → FEEDBACK
FEEDBACK → COMPLETED       （满意）
FEEDBACK → ADJUSTMENT      （还想调整）
ADJUSTMENT → MIXING        （接受 Vn+1）
```

语义约束：

- `RECIPE_SELECTION` 包含当前 Recipe Set 和单卡 deck；左滑是客户端动作，换一批是用户主动触发的后端动作。
- 右滑成功后才设置 `selectedRecipeId` 并进入 `MIXING`。
- `MIXING` 的 `currentStep` 是可恢复的服务端事实；完成最后一步后可置空并进入 `FEEDBACK`。
- `FEEDBACK` 的满意分支保存反馈和可选 final image 后进入 `COMPLETED`；不满意分支保存反馈后进入 `ADJUSTMENT`。
- `ADJUSTMENT` 的 proposal 与 current recipe 必须分开读取；接受 proposal 才更新当前配方并重置步骤。
- 不新增 `FINAL_PHOTO` SessionState。final drink 是可选图片和反馈字段，不是独立状态。
- 旧 checkpoint image 数据不改变状态语义，新 UI 不以它作为 MIXING 完成条件。

## 12. Reused capabilities

本 Pivot 复用而非重新发明：

| 能力                          | 复用内容                                                                    | 本 Pivot 的覆盖点                                  |
| ----------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------- |
| Session / SQLite / Repository | 会话快照、版本、事务、幂等、并发                                            | 只调整 UI 与新 regenerate 业务动作的接入点         |
| 图片与 Vision                 | 上传标准化、Vision Provider、识别、人工确认、ABV Guard                      | 继续支持桌面图、标签补拍；不改 Provider 合同       |
| 初次 Recipe Provider          | `generate()`、A/B/C、`RecipeCandidateSet` Zod、BLOCK repair/fallback        | 每批仍恰好 3 个；换一批是新批次，不是单卡生成      |
| Safety / recommendation       | deterministic Safety、Safety 审计、排序                                     | 每批重跑；UI 按排序展示，不按 A/B/C 固定排序       |
| Recipe selection              | `selectRecipe`、WARN 确认、版本冲突处理                                     | 右滑接入；左滑不调用它                             |
| Mixing backend                | currentStep、advance、back、刷新快照                                        | 新 UI 改为纵向 Stepper，忽略 checkpoint photo 要求 |
| Feedback / Adjustment         | `saveFeedback`、`generateAdjustment`、`acceptAdjustment`、`completeSession` | 满意优先；不满意才显示四维调整，持续 Vn+1          |
| Legacy checkpoint storage     | 旧表、字段、route 和 migration                                              | 保留兼容，不作为新版 UI 必经路径                   |

## 13. Explicit non-goals

当前最小 Demo 明确不做：

- 分享、分享海报和社交功能。
- 三张全部拒绝后的“拒绝原因”调查。
- 每左滑一次就实时调用模型生成候选。
- Mixing 中的过程拍照或 checkpoint photo 强制流程。
- 新的 `FINAL_PHOTO` SessionState。
- 云部署、登录、多用户、RAG、向量数据库、爬虫和硬件。
- 重新设计 M1/M2/13A/13B 后端基础合同。
- 修改或删除已发布 migration。
- 通过 UI、用户确认、Prompt、环境变量或 fallback 绕过 `BLOCK`。

## 14. Product acceptance criteria

产品负责人验收时必须能观察到：

1. 从确认材料后的一次生成中，后台持久化恰好三套 A/B/C；所有可选方案都有 Zod 和 deterministic Safety 结果。
2. 前端一次只显示一张卡，第一张为 recommendation ranking 第一名，而不是固定 A 卡。
3. 左滑只切换到本批下一张，不发生成、选择或 Feedback 请求。
4. 右滑调用既有 select 能力；成功后进入 `MIXING`，重复请求不会重复选择或推进版本。
5. 三张连续左滑后出现“换一批”；只有点击后才产生新生成操作。
6. 换一批成功后得到新的恰好三套 A/B/C，并重新经过 Zod、Safety、BLOCK repair/fallback 和 recommendation ranking。
7. 换一批失败时不丢失当前会话，不自动无限重试，用户可以安全重试。
8. Mixing 以纵向 Stepper 展示当前步骤；前进、后退和刷新都保留 `currentStep`，不要求 checkpoint photo。
9. 完成调制后首先出现“满意吗？”，满意分支不会先强迫填写四维反馈。
10. 满意后 final drink 可以成功拍摄，也可以跳过；两条路径都进入 `COMPLETED`。
11. final drink 上传失败时仍能通过跳过进入 `COMPLETED`，且不破坏满意 Feedback。
12. 选择“还想调整”后才出现甜度、酸度、酒感、浓郁度相对调整和可选备注；后端可生成一个 Vn+1。
13. 用户接受 Vn+1 后重新进入 `MIXING`，版本链保持父配方、反馈和 Safety 审计关联，并可再次回到满意判断。
14. 全流程不出现 `FINAL_PHOTO` 状态、分享入口、三卡同时展示作为主交互或每左滑一次的模型调用。
15. 刷新、重复提交、网络响应丢失和版本冲突都能通过现有快照、幂等和乐观并发机制恢复。

## 15. Known baseline gaps

以下是当前冻结 baseline 已知未完成项，不在本轮文档变更中实现：

- 现有 `RecipeSelectionScreen` 一次展示多张卡，并按 A/B/C strategy order 排列；尚未改为 recommendation-ranked 单卡 Swipe。
- 现有初次 `generateRecipeSet` 在 `READY` 生成固定三卡；`RECIPE_SELECTION` 下的“换一批”接入尚未实现，Task 3 必须调查并记录 API 方案后再实施。
- 现有 Recipe Set 和 `selectRecipe` 能力可复用，但新的 regenerate 是否扩展既有 POST 或新增 Route/用例仍需产品负责人决定。
- 现有 `MixingScreen` 仍渲染可选的 checkpoint photo 面板；新版 UI 尚未移除其用户路径，但旧后端/数据库能力必须保留。
- 当前 SessionShell 对 `FEEDBACK`、`ADJUSTMENT` 和 `COMPLETED` 仍显示占位状态；新版 Satisfaction-first、Vn+1 和 final drink UI 尚未实现。
- 仓库当前没有可执行 Playwright E2E；`pnpm test:e2e` 的已知结果为 `No tests found`。Task 7 必须建立真实闭环 E2E，建立后 E2E 成为阻塞发布门禁。
- 真实 Qwen Provider、真实手机相机和最终手机演示尚未在本 Product Pivot 中验证，留到 Task 8。

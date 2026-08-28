# AGENTS.md

本文件规定所有人类与编码 Agent 在本仓库中的工作方式。Codex 会在开始工作前读取本文件；若子目录以后需要更严格的局部规则，可在对应目录增加更近的 `AGENTS.md` 或临时 `AGENTS.override.md`。

## 1. 项目使命

构建一个手机优先、可在笔记本本地运行的白酒创意调饮 Agent。当前 Product Pivot 的主流程是：

```text
口味 → 拍摄桌面材料 → AI 识别 → 用户确认/修正/补拍
→ 后台每批生成 A/B/C 三套 → Zod → deterministic Safety → 推荐排序
→ 单卡 Swipe → 右滑接受 / 连续左滑三张后主动换一批
→ MIXING Stepper → “满意吗？”优先反馈
→ 可选 final drink → COMPLETED，或反馈生成 Vn+1 后重新 MIXING
```

当前范围是私人学习原型和本地 MVP。硬件控制、登录、多用户、云部署、RAG、向量数据库、抓取小红书和微服务不在范围内。

## 2. 开工前必读

按顺序阅读：

1. `docs/superpowers/specs/2026-08-28-guikesong-yqz-product-pivot.md`：当前产品交互、MVP 范围和覆盖决策的最高真相源。
2. `Task.md`：当前 Product Pivot 实施顺序、进度、验证命令与决策记录。
3. `PRODUCTION.md`：涉及运行、环境变量、数据库、图片、局域网、日志、备份或发布时必读。
4. `docs/superpowers/specs/2026-08-21-baijiu-cocktail-agent-design.md`：继承的 baseline 架构参考，未被新 Spec 覆盖的后端、安全和运行决策继续有效。
5. `docs/superpowers/specs/2026-08-27-task-13-feedback-loop-design.md`：继承的 Task 13A/13B Feedback / Adjustment 后端参考；旧 Task 13C 不属于当前计划。
6. 当前目录下更近的 `AGENTS.md`（若存在）。

发生冲突时：平台授权与安全边界 > 当前明确用户指令 > 已批准架构规格 > `Task.md` 实施细节。若用户指令改变已冻结产品或架构，先同步更新规格和 Decision Log；不要把冲突静默写进代码。

## 3. 预期仓库布局

```text
app/                  Next.js 页面与 Route Handlers
components/           UI 组件
src/application/      用例编排、事务、幂等
src/domain/           Zod Schema、类型、实体不变量
src/workflow/         会话状态机
src/agent/            生成、推荐和调整逻辑
src/safety/           确定性安全规则与计算
src/providers/        模型、搜索和 fallback 接口
src/repositories/     持久化接口
src/infrastructure/   Drizzle、SQLite、上传、Provider 实现
tests/                测试夹具、集成与 E2E
data/                 本地运行数据；禁止提交
learning/             用户手写练习；与生产代码隔离
docs/                 架构和补充文档
```

## 4. 固定技术栈

- Node.js 24 LTS；pnpm；提交 `pnpm-lock.yaml`。
- Next.js 16 App Router、React 19、TypeScript strict、Tailwind CSS 4。
- Zod 4。
- SQLite、Drizzle ORM、Drizzle Kit、better-sqlite3。
- sharp。
- Vitest 4、React Testing Library、Playwright。
- ESLint、Prettier、TypeScript。

只能安装规格或 `Task.md` 已列出的依赖。新增生产依赖、框架或基础设施前，必须说明现有方案为什么不够、体积与维护成本，并取得用户确认。

## 5. 常用命令契约

脚手架完成后，仓库必须提供以下命令：

```bash
pnpm install --frozen-lockfile
pnpm dev --hostname 0.0.0.0
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

若命令尚不存在，按 `Task.md` 的顺序创建；不要用临时命令掩盖缺失的标准脚本。

## 6. 工作协议

1. 一次只执行 `Task.md` 中一个未完成任务。
2. 先写会失败的测试并运行，确认失败原因与目标功能一致。
3. 写最小实现让测试通过；不要顺手扩大范围。
4. 运行该任务列出的局部验证，再运行受影响的更大测试集。
5. 更新 `Task.md`：勾选步骤、写 Progress、记录偏差或决策。
6. 提交应小而聚焦；禁止混入无关格式化或重构。
7. 宣称完成前必须运行 `AGENTS.md` 第 11 节的验证门禁。

如果实际仓库状态与计划不符，先调查并更新计划；不要假装文件、接口或依赖已经存在。

### Agent 分工

- Codex：负责调查、实施、测试、修复和提交。
- Claude Code：只做独立 Reviewer；默认不得修改生产代码、测试、migration 或文档，输出 `PASS/FAIL + Critical/Important/Minor findings`。
- Reviewer FAIL 后由 Codex 定点修复，再重新审查；Codex 与 Claude Code 不得同时写同一代码。

## 7. 架构不变量

依赖方向：

```text
UI → API → Application → Domain/Workflow/Agent/Safety
   → Repository/Provider interfaces → Infrastructure
```

必须遵守：

- Route Handler 只负责 HTTP、认证边界（未来）、Zod 解析和调用用例。
- UI 不直接访问 SQLite、文件系统或模型 SDK。
- Domain 不导入 Next.js、Drizzle、sharp 或具体 Provider。
- Provider 不推进会话状态，不直接写仓库。
- 多表写入和状态推进位于应用用例的单个事务中。
- 所有外部 JSON、数据库 JSON 字段和客户端输入都经过 Zod 校验。
- 会话状态只能通过 `src/workflow/` 的合法转换推进。
- 每个针对既有会话的变更 API 实现 `requestId` 幂等与 `expectedVersion` 乐观并发；创建会话没有既有版本，只要求 `requestId` 幂等。

### 7.1 Product Pivot 不变量

- 初次后台仍然每批生成恰好 3 个 A/B/C 候选；Provider 不因 Swipe UI 改成每次只生成一张。
- UI 一次只展示一张 Recipe Card，展示顺序按 recommendation ranking，而不是强制 A → B → C。
- 左滑只是前端浏览/拒绝当前候选的动作，不等于饮后 `accepted=false`，也不是后端 feedback。
- 三张全拒绝后必须由用户主动点击“换一批”；左滑本身不得实时调用模型生成新候选。
- Mixing 新 UI 不要求 checkpoint photo；旧 checkpoint 数据能力、数据库字段和 migration 保留，不删除旧 checkpoint migration。
- `FEEDBACK` 首先判断“满意 / 还想调整”；只有“还想调整”才展开详细四维相对 feedback。
- `final_drink` 是可选图片；跳过 `final_drink` 不得阻止 `COMPLETED`。
- 不新增 `FINAL_PHOTO` SessionState；分享、分享海报和社交功能不属于当前 MVP。

## 8. 安全不变量

- LLM 负责创意，`src/safety/` 的确定性规则拥有最终否决权。
- 安全级别只有 `ALLOW / WARN / BLOCK`。
- `BLOCK` 不可由 UI、用户确认、Prompt、环境变量或 fallback 绕过。
- 涉及酒类但 ABV 未确认时，不得生成可选配方。
- 酒精 + 能量饮料、药物、非食品材料、未知化学品必须 `BLOCK`。
- 缺乏可靠危险证据的奇怪食品组合不得伪装成医学禁忌；使用 `WARN` 和实验性标记。
- 每个安全命中必须保存规则 ID、规则版本、原因和替代建议。
- 被 `BLOCK` 的候选必须修复或替换，不能以禁用卡片凑足“三套可选方案”。审计信息可以展示，但最终仍要有三套可选择的 `ALLOW/WARN` 方案。

安全规则变更必须同时包含单元测试和证据引用。不得只修改 Prompt。

## 9. 数据、上传与秘密

- `.env*` 中的真实密钥、`data/`、数据库文件和用户图片不得提交。
- 只提交 `.env.example`，其中只含变量名和安全占位说明。
- 密钥只在服务端读取，禁止使用 `NEXT_PUBLIC_` 暴露模型密钥。
- 不在 URL、客户端响应、日志或测试快照中出现密钥。
- 上传需校验大小、扩展名、MIME、文件魔数和像素量；文件名由服务端生成，存于 Web 根目录外。
- 日志和 `decision_events` 只保存外显决策摘要，不保存隐藏思维链、完整 Prompt、图片二进制或敏感头。
- 匿名会话 ID 必须不可预测；不要在日志中打印完整会话 URL。
- 测试使用临时数据库与测试上传目录，测试结束后清理自身创建的数据。

## 10. 编码与测试规范

- TypeScript strict；不使用 `any` 绕过类型。确需未知输入时用 `unknown` + Zod。
- 领域逻辑优先写纯函数；时间、ID、Provider 和数据库通过依赖注入控制。
- 错误使用稳定错误码，不依赖中文文案做程序判断。
- React 组件保持展示/交互职责；业务编排放应用层。
- 数据库迁移只增量前进；不要手改已发布迁移。
- 测试名称描述行为与结果，不描述实现细节。
- 至少覆盖正常路径、边界值、非法输入和降级路径。
- 修 bug 时先补可复现测试。
- 不提交跳过测试的 `.only`、`.skip` 或失效断言。

## 11. 完成与验证门禁

任何任务完成前运行其局部测试。任何里程碑完成前必须全部通过：

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

涉及数据库时，还要从空数据库运行迁移；涉及手机体验时，还要按 `PRODUCTION.md` 在真实手机上完成指定 smoke test。

当前 Frozen Baseline 的已知 E2E 缺口是：`pnpm test:e2e` 返回 `No tests found`。这只说明 baseline 尚未建立可执行 E2E，不是最终 Demo 的通过结果；新版完整闭环必须在 Task 7 补齐 Playwright E2E，建立后 `pnpm test:e2e` 重新成为阻塞发布门禁。

完成报告必须给出：

- 改了什么，以及对应哪个任务/验收项。
- 实际运行过的命令与结果。
- 未运行的检查和原因。
- 剩余风险、fallback 或人工步骤。

没有验证输出，不得声称“完成”“已修复”或“全部通过”。

## 12. 学习目录边界

`learning/` 是思诚亲手复现概念的镜像练习区，不是生产代码来源。除非用户明确要求：

- 不覆盖他的手写练习。
- 不把生产组件复制进去冒充学习成果。
- 不因学习练习简化生产安全或类型边界。

第一天练习的推荐结构是：

```text
learning/day1-vanilla/index.html
learning/day1-vanilla/style.css
learning/day1-vanilla/app.js
```

## 13. 禁止事项

- 不擅自加入硬件、云服务、认证、RAG、爬虫或微服务。
- 不抓取小红书；公开搜索只能走可替换 `SearchProvider`。
- 不执行破坏性 Git 或数据命令，不删除用户已有改动。
- 不把模型输出当成可信输入。
- 不使用“食物相克”传言制造虚假确定性。
- 不以漂亮 UI 替代错误处理、fallback、测试和恢复能力。

## 14. 文档维护

- 架构或产品边界改变：更新正式规格与 Decision Log。
- 开发步骤或路径改变：更新 `Task.md`。
- 运行、环境变量、备份或故障处理改变：更新 `PRODUCTION.md`。
- 通用协作规则改变：更新本文件，并保持简洁；详细内容链接到对应文档。

参考：

- https://learn.chatgpt.com/docs/agent-configuration/agents-md
- https://learn.chatgpt.com/guides/best-practices
- https://developers.openai.com/cookbook/articles/codex_exec_plans

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

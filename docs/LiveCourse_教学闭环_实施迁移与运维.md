# LiveCourse 教学闭环：实施、迁移与运维说明

> 文档性质：`teaching-loop-next-phase`（spec revision 6）P-008 交付的运维/迁移说明，描述**当前工作树中已实现的**教学闭环（教—学—评—调）行为。本文只描述已实现代码，不承诺外部认证、多进程会话持久化、模型供应商执行或生产部署等未实现能力。
>
> 对应产品基线：[LiveCourse 功能说明](./LiveCourse_功能说明.md)
>
> 对应验收：A-012（revision 6，同一工作树全量验证），并给出 A-001 至 A-013 的精确命令。

## 1. 交付面总览（已实现）

| 面 | 代码位置 | 关键契约 |
| --- | --- | --- |
| 课程级计划 | `lib/livecourse/domain/course-plan.ts` | `CoursePlan`（schemaVersion 1）：courseId/title/version/status/goals/lessons(≥2)/checkpointRules；`.strict()` 拒绝悬空依赖、依赖环、重复 id、未知 goal 引用；无版本写入被拒绝。`projectCoursePlan()` 确定性投影为可执行 `LessonPlan[]`（深度冻结、按 order+id 排序）。 |
| 课时投影 | `lib/livecourse/domain/lesson-plan.ts`、`schemas.ts` | `LessonPlan`（schemaVersion 1）为单课时可执行投影，含 stageId、goals、nodes。 |
| 助教任务 | `lib/livecourse/domain/assistant-task.ts` | `AssistantTask`（schemaVersion 1），状态固定为 `queued→running→succeeded/failed/cancelled`；kind 白名单：`summarize_source`、`draft_feedback`、`draft_board_note`、`suggest_next_step`；`inputRefs` 是有界引用（≤8 条、≤240 字符、无空白）；事件流 `created/started/succeeded/failed/cancelled/requeued/confirmed`；`AssistantTaskService` 是内存中的单一生命周期权威，`fromSnapshot` 恢复时把 running 任务显式 requeue，终态不变。 |
| 统一证据 | `lib/livecourse/evidence/ingestion.ts` | `EvidenceIngestionService` 是唯一写入入口：`ingestCheckpoint`（确定性结果→`accepted`，模型评分→`pending_review`）、`ingestPBLEvaluation`/`ingestModelEvaluation`（模型评分**永远** `pending_review`）、`decideTeacherReview`（唯一能把模型工作接受/拒绝的路径）。`GoalState` 只由 `projectGoalState`（`lib/livecourse/domain/evidence-reducer.ts`）从已接受证据只读投影，任何路径都不能直接写掌握。 |
| 教学调整 | `lib/livecourse/domain/teaching-adjustment.ts` | `TeachingAdjustmentEngine` 确定性输出：节点级即时动作草稿（advance/remediate，经 `materializeImmediateAction` 转既有 `TeachingAction`）与课程级 `pending` 建议。`approveCourseAdjustment` 是唯一把 pending 调整写成**更高 CoursePlan 版本**的领域函数（只接受 `add_checkpoint` 类型化修订，拒绝任意 JSON patch）；`rejectCourseAdjustment` 不动计划。 |
| PBL 映射 | `lib/pbl/v2/course-evidence-adapter.ts`、`course-evidence-ingestion.ts` | 只映射已完成的 `PBLEvaluation`，必须显式提供 course/lesson/learner/goal/node + 持久化 scope；输出永远 `pending_review`；只保留安全摘要与 id，不复制 PBL 熟练度内核。 |
| 学科 Skill | `lib/livecourse/domain/subject-skill.ts`、`lib/livecourse/evidence/subject-skill-evidence.ts` | 第一个声明式 Skill：`skill:checkpoint-evaluation:v1`，由 `draft_feedback` 任务携带，固定工具 allowlist（`read_checkpoint`、`grade_with_rubric`）、固定输入前缀（`checkpoint:`、`rubric:`）；`validateSubjectSkillInvocation` 是唯一入口，先证明任务终态成功、kind/上下文/输入/工具匹配，才允许把结构化结果经 `ingestModelEvaluation` 写成 `pending_review` 证据。 |
| BKT/FSRS | `lib/livecourse/domain/mastery-model.ts`、`lib/livecourse/session/mastery-service.ts` | `MasteryService` 按 (stageId, learnerId, goalId) 分区；只消费 `accepted` 且带分数的证据；输出解释性掌握概率与复习建议，绝不写 `GoalState`/`CoursePlan`/课堂动作；支持 optIn/disable/enable/erase。 |
| 快照与恢复 | `lib/livecourse/session/course-state-snapshot.ts` | `CourseStateSnapshot`（schemaVersion 1）组合 CoursePlan + TeachingActionSnapshot + AssistantTaskSnapshot + EvidenceRecord[] + TeachingAdjustment[]；恢复是纯函数（不派发、不发布、不重放）；仅 `approved` 调整投影为已应用变更；running 任务 requeue。 |
| 课堂 UI | `components/livecourse/TeachingLoopPanel.tsx`，挂载于 `app/classroom/[id]/page.tsx` | 只调用受控 agent-session API；显示任务状态、失败、确认、调整与恢复标记，从不拼装领域记录。 |

## 2. ClassroomAgentSession 信任边界（R-012，P-007）

### 2.1 服务端独占字段（精确集合）

`classroomAgentSessionSchema`（`lib/livecourse/realtime/server/classroom-agent-session.ts`）只保存：

```
{
  schemaVersion: 1,
  sessionId,          // 不透明 token，默认 24 字节随机 hex
  courseId, lessonId, stageId, learnerId,
  realtimeTeacherAgentId,       // 服务端派生，如 realtime-teacher:{courseId}:{sha256 摘要16}
  assistantRoster: [
    { assistantAgentId, allowedTaskKinds, allowedTools }
  ],
  expiresAt,          // 默认 TTL 30 分钟（DEFAULT_CLASSROOM_AGENT_SESSION_TTL_MS）
}
```

- 身份与范围**全部由服务端派生**：教师 Agent id、助教名册（3 名：`assistant-notes-*`/`assistant-source-*`/`assistant-next-*`）来自 `deriveClassroomAgents`；`CoursePlan` 由 `readClassroom()`（服务端课堂存储）→ `deriveCoursePlanFromClassroomShape()` 生成（少于 2 个 scene 的课堂返回 `COURSE_LOOP_UNSUPPORTED` 400；两课时的第二课使用派生 stage `{stageId}:lesson-2`）。
- 请求体、URL、header、localStorage 与浏览器状态**不能**声明或提升教师/助教身份、课堂范围、任务权限或结果确认权。会话绑定路径上，客户端伪造 `x-teacher-key`/`x-teacher-agent-id`/`x-assistant-agent-id` 被显式拒绝：`403 FORGED_AGENT_IDENTITY`（`app/api/livecourse/realtime/tools/route.ts`）。

### 2.2 Cookie / 能力行为

- Cookie 名 `lc-agent-session`，值为不透明 token，`Path=/; HttpOnly; SameSite=Lax; Expires=…`（`agentSessionCookieHeader`）。读取只取 cookie，最长 128 字符；缺失→`SESSION_REQUIRED` 401，非法→`SESSION_INVALID`，未登记→`SESSION_MISSING`，过期→`SESSION_EXPIRED`。
- 实时工具路由的 `delegate_assistant_task` 只通过 `sessionDelegator`（默认实现从 cookie 解析 token → `service.delegateTool`）解析教师、名册、allowlist 与当前课堂位置；没有会话则 `401 SESSION_REQUIRED` 失败关闭。

### 2.3 任务 kind → 能力/工具映射（固定）

`ASSISTANT_TASK_CAPABILITIES`（`lib/livecourse/realtime/assistant-task-runner.ts`）：

| kind | capability | 名册工具 |
| --- | --- | --- |
| `summarize_source` | `read_source_reference` | 名册条目须含 `read_source_reference` |
| `draft_feedback` | `draft_classroom_note` | 名册条目须含 `draft_classroom_note` |
| `draft_board_note` | `draft_classroom_note` | 名册条目须含 `draft_classroom_note` |
| `suggest_next_step` | `read_lesson_reference` | 名册条目须含 `read_lesson_reference` |

生产装配不再使用确定性回显执行器。真实的 capability-scoped executor 尚未配置时，`unavailable-assistant-executor.ts` 会让任务显式进入 `failed`；确定性执行器仅保留在测试 fixture 中，不能产生生产态“伪成功”。

### 2.4 确认边界

- 只有 `succeeded` 且带 `result` 的任务可确认；`confirmedBy` 必须等于 `session.realtimeTeacherAgentId`，否则 403；非 succeeded 确认返回 `409 CONFIRMATION_NOT_ALLOWED`。
- `AssistantTaskConfirmation` 只把结构化 proposal 转成**一条**既有 `RealtimeTeachingCommand`（`lesson.goto_node` / `source.show` / `board.apply`），幂等键 `assistant-confirm:{taskId}`。确认先记录为 `applicationStatus=pending`；UI 必须 `await emitAction`，课堂运行时接受后再调用 `/confirm/applied` 标记 `applied`。派发失败时保留“重试应用”入口，相同命令幂等键会被复用。
- 失败/取消必须显式可见：`failed` 带 `failureReason`（≤240 字符，单行），`cancelled` 带 `cancellationReason`；终态不可被确认、不可被取消。

### 2.5 显式失败状态（可观察错误码）

| 场景 | HTTP | code |
| --- | --- | --- |
| 缺 cookie | 401 | `SESSION_REQUIRED` |
| token 非法/超长 | 401 | `SESSION_INVALID` |
| 会话不存在 | 401 | `SESSION_MISSING` |
| 会话过期 | 401 | `SESSION_EXPIRED` |
| 仅凭 learnerId 尝试恢复既有会话 | 403 | `SESSION_RESUME_REQUIRED` |
| 伪造 Agent header（会话绑定路径） | 403 | `FORGED_AGENT_IDENTITY` |
| course/lesson/node/scene 不匹配会话 | 403 | `CLASSROOM_COURSE_MISMATCH`/`CLASSROOM_LESSON_MISMATCH`/`CLASSROOM_NODE_MISMATCH`/`CLASSROOM_SCENE_MISMATCH` |
| 助教不在名册 / kind 不允许 / 工具不覆盖 | 403 | `ASSISTANT_NOT_ROSTERED`/`ASSISTANT_KIND_NOT_ALLOWED`/`ASSISTANT_TOOL_NOT_ALLOWED` |
| 未知 kind / 非法 identifier | 400 | `UNKNOWN_TASK_KIND`/`INVALID_IDENTIFIER` |
| 幂等键冲突（同键不同载荷） | 409 | `ASSISTANT_TASK_IDEMPOTENCY_CONFLICT`（路由层） |
| 确认非 succeeded 任务 | 409 | `CONFIRMATION_NOT_ALLOWED` |
| 调整不存在 / 已决定 | 404/409 | `ADJUSTMENT_NOT_FOUND`/`ADJUSTMENT_NOT_PENDING` |
| 恢复的课时缺失/不一致 | 409 | `RECOVERY_LESSON_INCOHERENT` |
| 课堂不可用于两课时闭环 | 400 | `COURSE_LOOP_UNSUPPORTED` |
| 服务端课堂不存在 | 404 | `CLASSROOM_NOT_FOUND` |
| 计划与课堂不匹配 | 500 | `CLASSROOM_PLAN_MISMATCH` |
| 未捕获异常 | 500 | `AGENT_SESSION_INTERNAL_ERROR`/`TOOL_GATEWAY_ERROR` |

### 2.6 永不存储的数据

- 供应商密钥、原始音视频、完整学习资料、由学习者输入派生的敏感内容：会话记录、任务日志、证据与模型状态都不保存。
- 证据只保存 id、归一化分数（0..1）、有界安全摘要与评估元数据；任务只保存有界 `inputRefs`；失败原因截断为 240 字符单行；`MasteryProfile` 只存派生信号（分数、时间戳、id），不存原始提交/音视频。

## 3. 正常两课时流程与浏览器边界

浏览器（`TeachingLoopPanel`）只调用下列受控服务端 API，**不创建领域记录、不声明 Agent 身份、不写持久化**：

| 步骤 | API | 行为 |
| --- | --- | --- |
| 0 | `POST /api/classroom` | 产品 API 持久化课堂（E2E 用它保证服务端课堂存储可解析计划）。 |
| 1 | `POST /api/livecourse/agent-session`（body：`{classroomId, learnerId}`） | 建立或恢复会话：服务端派生 CoursePlan/教师/名册，设置 httpOnly cookie，返回视图 + `restored` 标志。全新首次会话 `restored=false`，只有 reload 命中同一 (courseId, learnerId) 绑定才为 `true`。 |
| 2 | `GET /api/livecourse/agent-session` | 轮询当前会话状态（会话绑定视图，1.5s 默认轮询）。 |
| 3 | `POST /api/livecourse/agent-session/location` | 上报课堂位置；服务端校验 node/scene 属于当前课时范围后才存储。 |
| 4 | `POST /api/livecourse/agent-session/tasks` | 教师委派：body `{assistantId, kind, inputRefs, idempotencyKey, nodeId?, sceneId?}`。UI 对同一 pending 意图复用幂等键、终态响应后轮换，重试不会创建重复任务；路由先 `resolveToken` 失败关闭，再校验 body。返回 queued 任务；runner 随后异步执行到 `succeeded`/`failed`。 |
| 5 | `POST /api/livecourse/agent-session/tasks/[taskId]/confirm` | 服务端权威确认并返回 `{task, command}`，任务进入待应用状态；UI `await emitAction`。 |
| 5a | `POST /api/livecourse/agent-session/tasks/[taskId]/confirm/applied` | 课堂运行时接受命令后写入 `applied`；失败时保持 pending，可用同一幂等键重试。 |
| 6 | `POST /api/livecourse/agent-session/tasks/[taskId]/cancel` | 取消 queued/running；终态不可取消。 |
| 7 | 课堂 Quiz/PBL 路径 | 证据只通过 `LiveCourseSession.recordQuizEvidence` / 统一 RuntimeStore evidence repository 写入；教学面板不再提供手工录分入口。 |
| 8 | `POST /api/livecourse/agent-session/adjustments/[adjustmentId]/decision` | 教师批准/拒绝 pending 调整：批准写入新 CoursePlan 版本并（目标为其他课时时）原子推进 lessonId+stageId+location 到目标课首节点；拒绝不动计划。 |
| 9 | `POST /api/livecourse/realtime/tools`（`delegate_assistant_task`） | 实时工具路由的会话绑定委派路径（与面板共用 `service.delegate`/`delegateTool` 核心）。 |

当前 E2E 验证生产失败语义与会话凭证边界：未配置真实执行器时任务显式失败且无确认按钮；保留 opaque cookie 的 reload 可恢复同一进程内会话；清除 cookie 后，仅凭 learnerId 不能取回既有 session。

## 4. 持久化迁移、快照与回滚（R-008）

### 4.1 浏览器/PostgreSQL 的 CoursePlan 迁移与兼容读取（已实现）

存储包 `packages/@livecourse/storage` 是唯一浏览器/PostgreSQL/HTTP 持久化边界：

- `src/document/course-plan.ts`：`COURSE_PLAN_SCHEMA_VERSION = 1`。`migrateCoursePlan(value, stageId)` 读取时把已知的旧版（无 `schemaVersion`、有正整数 `version` 且具备完整形状，即短暂存在的 v0 浏览器课堂形状）**盖章为 schemaVersion 1**；无版本/畸形/未知版本分别抛 `CoursePlanMigrationError`（reason：`malformed`/`unsupported`/`missing-version`，带 `storedVersion`）。`assertWritableCoursePlan` **拒绝一切无版本写入**。
- 浏览器端（`src/document/browser.ts`）：IndexedDB 数据库版本 2，新增独立 `course-plans` 对象存储（`{stageId, coursePlan}`）；写事务内校验、读事务内迁移；`deleteDocument` 一并删除 course-plan 行。
- PostgreSQL（`src/document/pg.ts`）：`document_course_plans`（stage_id 主键引用 `document_stages`，JSONB `data`），`ensureDocumentSchema` 幂等建表；同一 `migrateCoursePlan` 读取迁移。
- HTTP 文档边界（`src/document/http.ts`、`src/server/document.ts`）：写路径 `assertWritableCoursePlan`，迁移失败映射为 `400 COURSE_PLAN_MIGRATION_FAILED`，详情带 `stageId`/`reason`/`storedVersion`，客户端 `HttpDocumentStore` 原样上浮。
- 兼容行为：同一旧记录在 Browser 与 Pg 读取得到相同 `{schemaVersion:1, version}`（A-002 的 `course-plan-migration.test.ts` 直接验证）；不支持的记录返回显式迁移错误，**不会**被重置为空课程。旧读取器（无 course-plan 的客户端）继续可用，因为 course-plan 是文档的可选元数据行。

### 4.2 快照/恢复、幂等与回滚

- `CourseStateSnapshot` v1（`lib/livecourse/session/course-state-snapshot.ts`）是唯一版本化、schema 校验的持久化单元；`buildCourseStateSnapshot` 与 `recoverCourseState` 都先过 `parseCourseStateSnapshot`。
- 恢复纪律：纯函数——不调用 `ClassroomController.dispatch`、不发布、不重放、不追加；课堂恢复点由已提交动作折叠；running 任务经 `recoverAssistantTaskSnapshot` 显式 requeue（`requeued` 事件），终态保持终态；仅 `approved` 调整投影为已应用变更，pending/rejected 仅作审计历史；不可读快照抛类型化错误（`CourseStateValidationError`/`CourseStatePartitionError`/`CourseStateSnapshotConflictError`/`CourseStateAdjustmentError`），没有静默空回退。
- 幂等：快照 id 由 (stage, learner, course, idempotencyKey) 确定性派生；相同语义重试返回原记录；id 或 idempotencyKey 被不同内容复用 → 显式冲突。
- 回滚策略：迁移是**新增版本化记录 + 兼容读取**，无破坏性改写。回滚 = 移除新写路径、保留新增数据与旧读取器直到迁移窗口关闭；禁用教学闭环只影响 UI 面板与 agent-session 路由，不影响既有课堂读写。

### 4.3 当前限制（如实声明）

- `ClassroomAgentSession` 运行时的会话与伴随状态（当前位置、任务、证据、调整）目前保存在**单进程内存**（`InMemoryClassroomAgentSessionStore` + `ClassroomAgentSessionState`）。会话绑定按 (courseId, learnerId) 保持，因此同一 dev-server/单进程内的页面刷新可以恢复（E2E 覆盖），但**没有多进程/多实例共享、没有跨重启持久化**。跨进程部署或重启后恢复需要把快照接到既有 `RuntimeStore`/持久化边界，属于未实现能力。
- 当前实现**没有外部认证/账号体系**：`learnerId` 是课堂会话上下文提供的分区键；未实现多租户、面向第三方的稳定公共 API 或生产部署保障。
- 生产助教执行器尚未接入；任务会显式失败，不会回显输入制造成功结果。

## 5. 启动、验证、故障诊断与安全回退

### 5.1 启动

```sh
pnpm install            # postinstall 会构建 packages/@livecourse/* 与同步 importer
pnpm dev                # 开发（Node >= 20.9，pnpm 10.28；http://localhost:3000）
pnpm build && pnpm start  # 生产构建后启动
```

可选 PostgreSQL 持久化与视频渲染：见 `docker-compose.yml` 与 README 的 profile 说明（不属于教学闭环的已实现能力）。

### 5.2 验证命令

见第 6 节 A-001 至 A-013 精确命令。日常回归：

```sh
pnpm test               # vitest run --maxWorkers=4
pnpm lint               # eslint
pnpm check              # prettier . --check
pnpm build
pnpm test:e2e           # playwright test
```

### 5.3 可观察错误与日志

- 所有 agent-session 路由返回统一 JSON：`{ "error": { "code", "message" } }`，`Cache-Control: no-store`（`app/api/livecourse/agent-session/helpers.ts`）。
- 服务端日志关键字：`Agent session API failed`、`Realtime tool gateway failed`（未捕获异常 → 500）；课堂加载日志走 `createLogger('Classroom')`。
- 故障排查对照：
  - 面板显示“会话失效”且清空任务列表 → cookie 缺失/伪造/过期（`SESSION_*`）；重新加载课堂以重建会话。
  - 委派返回 401/403 → 检查 cookie 是否被清、header 是否夹带伪造 Agent 身份、node/scene 是否属于当前课时。
  - 409 幂等冲突 → 同一幂等键被不同载荷复用；UI 的 pending key 旋转逻辑保证同意图重试幂等，新意图新键。
  - 任务 `failed` 带 `failureReason` → 助教输入引用不满足能力（如 `summarize_source` 缺 `source:` 前缀）。
  - 第二课未出现 → 检查检查点证据是否 `accepted`、调整是否 `pending`、是否已批准且 `coursePlanVersion` 与当前版本一致（stale plan 会抛 `CourseAdjustmentStalePlanError`）。

### 5.4 安全禁用/回退

1. 禁用闭环 UI：从 `app/classroom/[id]/page.tsx` 移除 `<TeachingLoopPanel />`；agent-session 路由不调用即不产生会话/任务/证据副作用。
2. 禁用实时委派：`app/api/livecourse/realtime/tools/route.ts` 去掉 `sessionDelegator`（恢复默认 fail-closed，即无受信网关时委派失败）；对任意 kind 可同时移除名册中对应条目。
3. 迁移回滚：不删除数据；把代码回退到迁移前版本，旧读取器继续工作；新增 course-plan 行保留。不要手动改写/删除 IndexedDB 或 PG 数据行。
4. 长期模型关闭：见第 7 节（disable/erase 为产品内能力）。

## 6. A-001 至 A-013 验收命令（spec revision 6）

> 按 SPEC §8 原样列出。针对性后端 Vitest 验收命令（A-001 至 A-010、A-013）在账本证据中均以**能终止整个进程组的 60 秒硬超时**执行（含 `pnpm`/vitest 子进程组，非单进程 alarm）。**全仓 446 个测试文件的聚合套件（`pnpm test` = `vitest run --maxWorkers=4`）不是单个后端单测命令，不施加 60 秒总时限**，其超时由 vitest 默认及测试内显式超时控制。

| ID | 精确命令 |
| --- | --- |
| A-001 | `pnpm vitest run tests/livecourse/course-plan.test.ts tests/livecourse/course-plan-projection.test.ts --maxWorkers=4` |
| A-002 | `pnpm vitest run tests/livecourse/course-plan-migration.test.ts tests/persistence/course-plan-route.test.ts --maxWorkers=4` |
| A-003 | `pnpm vitest run tests/livecourse/realtime-session.test.ts tests/livecourse/classroom-controller.test.ts --maxWorkers=4` |
| A-004 | `pnpm vitest run tests/livecourse/assistant-task-gateway.test.ts tests/livecourse/assistant-task-schema.test.ts --maxWorkers=4` |
| A-005 | `pnpm vitest run tests/livecourse/assistant-task-runner.test.ts tests/livecourse/assistant-task-recovery.test.ts tests/livecourse/assistant-task-confirmation.test.ts --maxWorkers=4` |
| A-006 | `pnpm vitest run tests/livecourse/evidence-ingestion.test.ts tests/livecourse/evidence-reducer.test.ts tests/pbl/v2/course-evidence-adapter.test.ts --maxWorkers=4` |
| A-007 | `pnpm vitest run tests/livecourse/teaching-adjustment.test.ts tests/livecourse/course-adjustment-approval.test.ts --maxWorkers=4` |
| A-008 | `pnpm vitest run tests/livecourse/course-recovery.test.ts tests/runtime/course-state-roundtrip.test.ts --maxWorkers=4` |
| A-009 | `pnpm vitest run tests/pbl/v2/course-integration.test.ts tests/livecourse/skill-task-contract.test.ts --maxWorkers=4` |
| A-010 | `pnpm vitest run tests/livecourse/mastery-model.test.ts tests/livecourse/review-schedule.test.ts tests/livecourse/learner-data-deletion.test.ts --maxWorkers=4` |
| A-011 | `pnpm playwright test e2e/tests/teaching-loop.spec.ts` |
| A-012 | `pnpm exec tsc --noEmit && pnpm lint && pnpm test && pnpm build` |
| A-013 | `pnpm vitest run tests/livecourse/classroom-agent-session.test.ts tests/livecourse/assistant-task-gateway.test.ts tests/livecourse/assistant-task-confirmation.test.ts tests/livecourse/assistant-task-recovery.test.ts --maxWorkers=4` |

A-012 的 revision 6 语义：同一工作树内**原样**依次完成类型检查（`pnpm exec tsc --noEmit`）、代码风格（`pnpm lint`）、完整后端单测（`pnpm test` = `vitest run --maxWorkers=4`，全仓 446 文件聚合套件，无 60 秒总时限）与生产构建（`pnpm build`）；不得以过滤 `.next` 的替代 typecheck 冒充通过。若 `.next` 生成物陈旧，先以可重建的构建生命周期纠正，再重新运行 revision 6 命令。A-001 至 A-010、A-013 等针对性后端单测命令继续以 60 秒进程组硬超时执行。

## 7. 隐私与数据最小化、长期模型禁用/删除

- 最小化：证据与任务只保存 id、归一化分数、有界安全摘要、有界引用与时间戳；原始音视频、供应商密钥、短期凭证和非必要学习资料不进入任务日志、模型提示或遥测；错误消息单行截断。
- 长期模型（BKT/FSRS）：
  - `MasteryService.optIn` 创建显式启用的档案；`disable` 停止未来更新与调度；`enable` 重新启用；`erase` 彻底删除，之后读取/调度抛 `ERASED`，**没有静默回退档案**（必须再次 optIn）。
  - 只消费 `accepted` 且带分数的证据；跨 learner/goal 的证据在写入前抛 `PARTITION_MISMATCH`；档案只存派生信号，不存原始内容。
  - 模型输出只是解释性建议，绝不直接判定成绩、写 `GoalState`、改 `CoursePlan` 或派发课堂动作。
- 会话记录字段最小（第 2.1 节），`expiresAt` 30 分钟过期；`DELETE /api/livecourse/agent-session` 撤销会话并清除 cookie。

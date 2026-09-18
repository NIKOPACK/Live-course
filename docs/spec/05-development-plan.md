# 开发计划

先减后加。做完一期再开下一期。每一期的验收是完成标准。

依据：[02-product-manual.md](02-product-manual.md)、[04-detailed-design.md](04-detailed-design.md)。干活方式：[06-agent-protocol.md](06-agent-protocol.md)。

S0–S1 不新增 `lib/livecourse` 领域文件。A1 才允许新文件，且必须先写进 `04-detailed-design`。

## S0 死代码

减：

- `package.json` 里无引用的 `@copilotkit/backend`、`@copilotkit/runtime`、`copilotkit`
- `tsconfig.json` 的 `"openclaw"` exclude
- README / `packages/docs` getting-started 的圆桌、一键生成同学课、把 BKT/FSRS 写成当前能力的句子

改成：一位老师把课教完；当前能跑的是单堂课生成与上课。

验收：`pnpm test`、`pnpm lint`、`pnpm check` 仍过；README 不再把未做项写成已有。

## S1 减法

减入口，不重写材料层：

- `lib/orchestration/registry/store.ts`：默认名册只留教师
- `app/api/generate/agent-profiles`：默认不生成会发言的同学 / 助教
- `app/page.tsx`：去掉 `interactiveMode`、`vocationalTestMode` 主开关
- 课堂壳：去掉编辑态 / Pro 模式入口（`isLiveCourseEditorEnabled` 保持默认关，Header / Stage 不再露出切换）
- `app/eval/whiteboard`：移出主路由或仅开发环境可见

验收：

- 新生成的课只有教师开口
- 插话后能回到原节点
- 按手册走完 J1–J5，碰不到改课界面、三种模式或同学气泡

## S2 手册与交互模式对齐

首页、预览、课堂壳、课后和设置的控件 / 文案按手册改。检索等可选项只留在设置。实现以 `01`「每步交互契约」为状态机权威，不得只对齐 happy path。

验收按每一步记录：成功输入与可见反馈、允许时的跳过、失败后的原地恢复、唯一终态 / 下一状态、W / C / L 正向与负向读写。至少覆盖：

- 首页空目标保持禁用，行内提示由目标框 touched / blur 或键盘提交尝试触发而非 disabled click；覆盖逐文件上传失败、单次「开始上课」防重复，以及问题 / 范围完成后自动进预览且无第二个同名按钮
- 范围首次加载失败且无推荐缓存时可重试或按需求与合理默认跳过；树已加载后的确认 / 提交失败保留已选与缓存推荐项，可重试或使用缓存推荐范围
- 预览四种分段状态、正常生成或已完成段可点开只读查看教案与课堂材料、只重试失败段、成功段不重做、尚未生成完成的首页卡片回到预览、全部完成后显式进入课堂、课堂加载失败留在预览
- 课堂讲授 / 插话 / 检查 / 暂停 / 继续 / 重听各自成功和失败；任何失败不推进，重听不产生证据，必要检查未完成时课程保持未完成
- 未完成课堂只通过「暂时离开课堂」执行 `saveAndLeaveSession`：成功先关闭本趟实时教师、再写 C、再销毁 W、最后导航；关闭实时教师或保存失败留课堂重试，浏览器 / 标签卸载 best-effort 不算成功。首页老师不接入课堂实时音频
- 最后必需动作后唯一进入 `completed → finalizing`；`finalizeSession` 失败停留重试，成功归档后才销毁 W 并显示课后选择
- 首页同课与课后「再听」共用独立 `replaySession`：每次新建 replay W，播放 C 中持久化已讲范围（完成课为全课），支持暂停 / 继续 / 结束重听；加载失败留在各自选择态，播放失败保留回放位置可重试；自然结束或结束重听销毁 replay W，并按入口返回首页同课或课后选择态。负测 replay 不 finalize、不写 C/L、不产 `EvidenceRecord`、不重判 `GoalState`
- 首页同课「继续」只对未完成课程可用：读 C+L、新建 teaching W、恢复持久化未完成位置；加载失败留在首页同课选择态，绝不恢复旧 W、进入 replay 或创建新课程
- 设置遮罩字段、联网默认关、显式保存和字段级失败；设置失败不影响课程，也不出现画像编辑器
- 全程没有同学气泡、三种模式、编辑器或未在手册中声明的主按钮

## A1 先设计再生成

大纲与内容之间写入 `LessonPlan`。教案设计 Agent 把每条大纲展开成节点讲授设计：讲什么（teachingPoints）、怎么讲（explanationPlan）、例子、预设学生问题与回应（anticipatedQuestions）、易错点（misconceptions）。教案随文档持久化，并必须带 HTML 视觉方向；课堂运行时只读这份教案，缺 presentation 不得打开。逐段内容生成以教案节点为输入。

约束：教案设计 Agent 是台后 worker；学习者在任何画面只面对一位 Agent 老师（`02` 首页节）。

验收：

- 每堂课先有含讲授设计、预设问答和 HTML 视觉方向的教案，再有课堂页
- 教案随课持久化，再打开同一堂课时直接读取，不靠反推
- 生成与上课全程，界面上学习者只看到一位 Agent

## A2 台后学情

学情摘要进入 Realtime 短上下文。检查结果能触发再讲或往下（`TeachingAdjustment`）。模块放在 `lib/livecourse/`。课堂控制器同时落实 `04` §1 的类型化命令、状态机与幂等边界。

验收：

- A2 新增权威、类型化、幂等 `lesson.complete_node` schema；验证现有 schema 不被假称已有。只有教师 speech / action 都成功结束且控制器提交事件后才推进节点
- 事件去重后更新 W，并立即持久化 `C.completedNode / C.progress`；同一事件重试不重复推进。它不生成 `EvidenceRecord`、不投影掌握；音频 / 节点加载失败或播放游标到达不能提交
- 插话成功按「直接回应（不复述问题）→ 基于内容自然衔接 → 回答音频结束后恢复 `resumeNode`」完成；OpenAI / Volc、文字 / 麦克风遵循同一规则。识别失败提示重说并保留恢复点
- 显式开始讲授后每条节点讲稿实际通过 Realtime 发声；断开 / 未配置 / 音频失败时不提交 speech end 或 `lesson.complete_node`，无静音计时器成功路径
- 文字问题与麦克风复用同一插话事务；文字发送失败保留输入；检查等待期间可以提问，答完仍回原检查；暂停 / 插话后从未讲完语音块恢复，不重播当次已完成块、不把取消当成功。续讲上下文含已播完 / 恢复 / 后续内容，且不把问题字幕在回答后重新写回
- 讲授成功后不依赖旧自动播放设置即可进入下一节点；检查后真实语音反馈（答错含解释）成功才继续或归档，反馈失败可重试且同一提交仅一条证据；课中重听自动播放并返回原位置
- 含简答题的课程也能完成：有效模型评分允许完成检查，但保留 pending_review 和模型来源，不伪造人工审核、不把它投影为已掌握
- 检查显式提交后显示对错和反馈，教师上下文含「会 / 不会」并能换节点；判分失败保留答案，重试同一提交只产生一个 `EvidenceRecord`
- 必要检查没有有效 evidence 时不能进入完成态；最后一个必需讲授节点完成，或最后一个必要检查已有有效 evidence 且补齐最后动作时，只能迁移 `completed → finalizing → J4.1`
- 暂停 / 继续失败不推进；课中重听只覆盖已讲部分并回原位置，不新增证据或重判掌握
- 续学位置按同一学习者 / 课程持久化到当前语音块；退出重开恢复章节与画面，旧快照兼容；保存失败不继续播放或离开。上一 / 下一章节按教案顺序导航、边界禁用、切换后不自动发声；跳转不增加已完成数，未完成必要检查仍阻止全课完成
- 未完成课程点「暂时离开课堂」后，`saveAndLeaveSession` 成功顺序为关闭本趟实时教师会话 → 写 C 恢复点 → 销毁 W → 导航首页；关闭实时教师或保存失败留课堂且 W 可重试。关闭 / 返回 / unload 只能 best-effort，不能通过成功迁移断言。负测：离开后首页形象不得订阅课堂口型桥，也不得续上上一堂课的模型侧对话
- `finalizeSession` 是唯一完成归档命令且幂等：成功归档 W→C 与合法 candidate→L 后才销毁 W、进入课后选择；任一步失败停在 `finalizing` 并可重试，不重复归档
- 首页同课「继续」只为未完成教学读取 C+L、新建 teaching W 并恢复持久化未完成位置；已完成课程不可继续，加载失败留首页同课选择态，且任何分支都不恢复旧 W 或创建新课程
- 首页同课与课后「再听」共用 `replaySession`：每次新建独立 replay W，播放 C 中持久化已讲范围（完成课为全课），支持暂停 / 继续 /「结束重听」；加载失败留在发起入口选择态，播放失败保留当前回放位置可重试；自然结束或结束重听销毁 replay W，并分别返回首页同课选择态 / 课后选择态。负测它不调用 finalize、不写 C/L、不新增 `EvidenceRecord`、不重判 `GoalState`；J4.3「离开」只导航

## A3 课前追问与大纲工作流

加：

- 预览页课前问题卡片（生成教案之前）：Agent 只对会改变本课设计、且本次输入与适用记忆都不能可靠回答的范围、本主题当前程度、目标、教学方法、深度、节奏或互动方式产出少量带选项问题；学习者可逐项或整体跳过（`02` 生成预览节）
- 知识分解：仅在范围不明确时，分解 Agent 列出主题知识点树，学习者勾选范围，默认勾选推荐项（`04` §7）
- 大纲工作流：课前追问 → 按需分解 → 组装 → 审校，编排沿用 langgraph；大纲生成把课前答案与勾选范围作为输入（`lib/livecourse/outline/`）

验收：

- 输入「我想学高数」会出现范围可选项，而不是直接猜
- 输入具体主题「教我链式法则」但未说明程度时，可以出现本主题程度问题；主题具体不再被当成绝对的“无追问”条件
- 输入「用图示、少公式教我链式法则」时，不重复询问已经明确的教学方法
- A6 接入后，适用 `LearnerMemory` 已可靠记录教学方法或节奏时不重复询问；本次明确表达仍优先
- 勾选范围后，大纲只覆盖所选知识点
- 首页只有一个「开始上课」；空目标保持禁用，必填提示由目标框 touched / blur 或键盘提交尝试触发，不依赖 disabled click；提交中防重复。可选资料逐文件反馈，单项失败可重试 / 移除且不清空目标或其他成功项；提交后直接进入预览页，课前确认在预览页内完成
- 问题逐题点选并用「继续」，可逐题或整体跳过；失败保留已答并可重试或跳过
- 范围树推荐项默认勾选，可「按所选范围备课」或「使用推荐范围」；首次加载失败且没有推荐缓存时提供重试，或明确「跳过范围确认，按需求与合理默认备课」
- 树成功加载后缓存已选与推荐项；确认 / 提交失败时两者不丢，可重试提交或使用缓存推荐范围。两类失败不得展示不实际存在的推荐项
- 所有问题与范围勾选都可跳过，不形成必填长问卷；信息已经足够时首次提交后直接进入生成预览
- 问题 / 范围完成后自动进入预览，不出现第二个「开始上课」；开始生成时只创建一个 `courseId` 并归档一份需求 / 回答 / 范围

## A4 生成工作流 subagent 化

worker Agent 支持派生并行 subagent（`04` §7）：

- `lib/livecourse/outline/subagent.ts`：pi 运行时的 subagent 运行器（并发上限、失败降级）
- 知识分解两段式：粗分枝干 → 每枝干并行 subagent 细分解 → 合并知识点树
- 教案设计按节点并行 subagent，代码侧组装校验

约束：subagent 不改变自己身份露出——台前仍然只有一位 Agent 老师。

验收：

- 「高数」级大主题分解出的知识点覆盖完整（每枝干由独立 subagent 展开）
- 任一 subagent 失败时整体降级为单调用，生成不中断
- 多节点教案的每节点设计由并行 subagent 产出，总耗时不随节点数线性增长

## A5 教案配图

加：

- 教案节点 design 增加 `visualAids` 声明式配图意图（`04` §5）：教案设计 Agent（含按节点 fan-out 的 subagent）为需要静态示意图的节点产出配图需求（占位 id、生成 prompt、用途、宽高比）
- `lib/livecourse/lesson/visual-aids.ts`：逐段内容生成前把 visualAids 合并进对应 outline 的 `mediaGenerations`（`04` §7）；两条生成链路（一键生成 `lib/server/classroom-generation.ts`、预览生成 `app/generation-preview/`）共用同一转换
- 执行沿用 media-orchestrator 与 `/api/generate/image` 及 `lib/media` 适配器矩阵；subagent 保持无工具，不新增 provider 路径

约束：教案 schema 的 visualAids 仍为可选；教案侧不直接调图片生成 API。

验收：

- 需要图示的课（如「水循环」）生成的幻灯片含 AI 生成配图，图内文字语言与课程语言一致
- 无配图需求的节点不产出 mediaGenerations；未配置图片 provider 时生成不中断（沿用现有降级）
- 无 HTML 视觉方向的课不得打开或生成

## A5.1 模型原生 HTML 课堂

依据：`01` J2/J3、`02` 生成预览与课堂、`04` §7 补充。

主 Agent 先确定全课视觉方向并随教案持久化，再逐页生成自由 HTML/CSS/SVG/Canvas/JavaScript。新课不再受固定 slide 元素或 widget 模板限制；检查页同样使用 HTML，但结构化题目和原有判分/证据逻辑不变。

验收：浏览器与服务端生成都使用同一课程方向；每页 HTML 真实显示在课堂、只读预览与缩略图；失败段重试不改变风格或成功段；无效 HTML 显式失败；检查显式提交、失败恢复及 replay 无证据写入保持不变；无 `presentation.mode = html` 的课打开失败，不回退到幻灯片 / widget / PBL。

## A5.2 课程封面

依据：`01` J2.0c / J4.4、`02` 首页最近课堂、`04` §3 / §7。

加：

- 主 Agent 视觉方向 JSON 增加可选 `coverPrompt`；`lib/livecourse/lesson/course-cover.ts` 解析、fallback 与跳过规则
- 教案视觉方向落盘后，与逐页内容并行调用现有图片通道生成 16:9 封面；`Stage.coverAssetId` 与 `DocumentSummary.coverAssetId` 供首页卡片读取
- 两条生成链路（预览 `generation-preview` / `use-scene-generator`，一键 `classroom-generation.ts`）共用同一声明与降级

约束：封面不是教案节点配图，不进 `mediaGenerations`；subagent 无工具；不新增图片 provider；失败或未配置不中断备课；学习者不能改封面。

验收：

- 新课首页最近课堂左侧显示 AI 封面，构图 16:9，风格与该课 `visualStyle` 同源
- 备课中或封面失败时卡片仍可点，走现有 J2.1 / J4.4
- 未配置图片 provider 或关闭图片生成时整课生成不中断
- 封面不进检查、不产 `EvidenceRecord`、不写 W / C / L
- 预览链与服务端一键链行为一致

## J3.2a 口头问答增量

依据：`01` J3.2a、`02`「讲授中的口头问答」、`04`「J3.2a 口头问答实现缝」。

验收：教案可保存预设问题并在讲稿中段触发；老师问完真正等待语音或文字，依据回答最多追问两次；提示、继续、识别失败、回应失败重试、暂停取消与回放不提问都有明确边界；OpenAI 与 Volc 共用同一有限轮次控制，不新增语音供应商、判分或学习证据。无 HTML 课不得打开，因此也不改写或补写旧格式。

## A6 多层记忆闭环

先按 `04` §6 建立作用域和确定性 policy，不引入新库：

- 当前课堂工作记忆：以 `classroomSessionId` 隔离，保存当前节点、插话 / 恢复点、当前作答与有上限短摘要；复用现有课堂控制器、动作日志与恢复缝
- 同课程学习记忆：以 `learnerId + courseId` 隔离，复用 `EvidenceRecord → GoalState`、evidence append stream、`CourseStateSnapshot` 与 `RuntimeStore`；课程 API 缺 `courseId` 必须 fail closed
- 跨课程学习者记忆：以 `learnerId` 隔离，白名单只允许学习者本人的稳定偏好、节奏、互动 / 反馈方式、无障碍需要与稳定约束；模型只产 candidate，确定性 policy 校验来源、置信度、更新时间与字段后才写
- 上下文组装：本次明确表达 > 当前课堂 > 同课程 > 跨课程学习者画像 > 默认值；同课重开读同课程 + learner-only，新课只读 learner-only
- 事实一致性：evidence append stream 是权威事实；snapshot 只作有水位的恢复物化 / 引用，由统一协调器产生，禁止独立双写两套 evidence
- 存储继续走现有 IndexedDB / HTTP / PostgreSQL 矩阵与 contract tests；参考 LangGraph 的 thread / Store、Mem0 的 scope metadata、Letta 的 bounded core / archival、Moodle 的 evidence / state 分离，但不引入这些项目的第二 runtime 或依赖

约束：

- 禁止通用自由文本 memory blob，禁止跨课程读取课程名、知识点、题答、分数、掌握结论、课程摘要或原始对话
- 学习程度只属于当前课程 / 主题；一次行为不能形成永久全局标签；当前明确表达始终在本课优先，但首页草稿与课前答案只在生成开始写当前 C，不立即写 L。只有 `finalizeSession` 时，长期 / 通常显式偏好或跨多课证据达到 policy 门槛的 learner-only candidate 才可写 L
- 跨课程不等于跨设备；本期不新增账号关联、设备合并、同步冲突处理、画像编辑器或跨设备档案
- BKT / FSRS 仍不进入本期

验收：

- **同课重开**：同一 `learnerId + courseId` 再打开时，教师能恢复该课程进度、作答证据、误解 / 未解决问题和适用学习者偏好；未归档 session 临时项不冒充持久事实
- **不同课新开**：同一学习者新建不同 `courseId` 时，可复用「偏好图示、先例后理、合适节奏」等 learner-only 属性，但必须重新判断本主题程度
- **负向串课**：以两个 course fixture 验证新课 prompt / 生成输入中不存在上一课的课程名、LessonPlan、知识点、题目、答案、分数、掌握结论、课程摘要或原始对话；缺 `courseId` 的课程记忆读取明确失败
- **显式偏好边界**：J1 草稿与课前答案在生成前不写 C/L，生成开始时只写当前 C；当前表达立即覆盖本课历史。非「长期 / 通常」表达在 finalization 也不写 L；明确长期 / 通常表达或跨多课证据达到门槛的 candidate 只在 finalization 经 policy 写 L
- **随证据更新画像**：来自多门课程的独立证据达到门槛后，才可在对应 session finalization 更新受支持 learner-only 属性的来源数、置信度或更新时间；单次矛盾行为不静默覆盖稳定偏好，本次明确表达只在本课优先
- **学习者隔离**：两个 `learnerId` 和两个 `courseId` 的自动化夹具证明 session / course / learner 三层均不串用
- **交互事件归档**：开始生成只把需求 / 回答 / 最终范围写当前 `C`；进入课堂新建 `W`；插话只写 `W`（未解决问题可归 `C`），原始对话不进 `L`；`lesson.complete_node` 更新 W 并立即持久化 C 进度但不产 evidence；检查唯一 append evidence；暂停 / 回放仅写恢复状态
- **生命周期顺序**：未完成离开只走 `saveAndLeaveSession` 并按 C→销毁W→导航排序；完成课只走 `finalizeSession` 并在 W→C、合法 candidate→L 全成功后销毁 W；首页 / 课后 replay 每次只创建 / 销毁独立 replay W，加载失败留各自选择态，播放失败保留位置，自然 / 显式结束回各自选择态；课后离开不读写记忆
- **同课入口**：「继续」只读同一 `C + L` 并为未完成教学新建 teaching `W`；「再听」为 `C` 中持久化已讲范围新建 replay `W`（完成课为全课）。两者绝不恢复旧 `W`；恢复失败可重试 / 返回且不创建新课程；replay 不 finalize、不写 C/L、不新增 `EvidenceRecord`、不重判 `GoalState`
- **设置负向隔离**：设置保存与失败重试均不读写 W / C / L，不产生画像条目；普通首页草稿、上传缓存和媒体加载也不进入学习记忆
- **重试幂等**：检查判分重试、分段生成重试、节点加载重试、`lesson.complete_node`、`saveAndLeaveSession` 与 `finalizeSession` 重试各自复用稳定 idempotency key；只有检查可产 evidence，且同一提交最多一个
- **存储一致**：Browser IndexedDB 与 HTTP / PostgreSQL adapter 的相同 contract tests 覆盖 schema、namespace、幂等 / CAS 与删除边界；本期未配置的后端不阻塞本地课堂

## A7 课程删除

依据：`01` J4.5、`02` 首页、`04` §3 / §6。

加：

- 首页最近课堂独立删除控件 + 确认框硬删除一门自己生成的课（含备课中）
- `deleteClassroom` 与 `DELETE /api/classroom`；客户端沿用 `deleteStageData`，成功谓词为服务端 200/404 且 `listStages()` 不再含该 id
- 展示课 `fourier-intro` 不可删

约束：不碰 L；不改 §7「返回首页保留可恢复的 generation session」原句；不反转 `loadFromStorage` 的 server-restore fallthrough；不新增 DocumentStore API。in-flight `/api/generate-classroom` 在 DELETE 后 `persistClassroom` **不是** 本期验收。

验收：

- 首页卡片可确认删除；取消不改数据。展示课无删除入口。`DELETE /api/classroom?id=fourier-intro` 为 400，文件仍在
- **主成功路径：** 无服务端文件的 J1 课，确认后卡片消失
- 成功：卡片消失（含无 `preparingClassroom` 鬼魂）；空架文案现有；该课 C / W / evidence **经产品路径不可读**（新课上下文、再打开）；L 仍在；新课不出现已删课内容。不要求 runtime DB 物理清空
- 备课中的课可删且 generation session 仅在成功谓词后被清。从预览返回首页仍保留可恢复 session（§7 原句）
- 失败：确认框保持打开，卡片仍在，可重试
- 一点确认即关掉该课 `CourseEntryDialog`；继续 / 再听不能在删除后导航
- runner **未在跑** 时，`GET /api/classroom?id=` 对已删 id 为 404；打开该课堂 URL 不恢复
- 封面资源计入回收（现有 collect-stage-asset-refs + cascade）
- 不出现回收站、课堂内删除、对 L 的写入
- **非验收：** in-flight `generateClassroom` 在 DELETE 后写回文件

## A8 及以后

A8 尚未定义。多课时课程规划、BKT / FSRS、摄像头仅是未来候选；任何功能必须先按 `docs/spec` 权威顺序写入旅程、手册、设计和可测验收后才能开发。在此之前继续禁止，作品简介不能授权开发。

## 完成标准

声称某期完成时，该期验收条条可演示或可测。涉及交互的验收必须逐步引用 `01` 六列契约，并同时证明成功、允许时的跳过、失败恢复、终态和 W / C / L 正负读写；不能用“页面能打开”代替。未通过验收不得开始下一期。

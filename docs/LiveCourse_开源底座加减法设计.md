# LiveCourse 开源底座加减法设计

> 仓库由 [THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) 迁入并改名。OpenMAIC 提供了可用的课堂材料层，但其产品主模型与 LiveCourse 的开发要求不一致。
> 本文只做改造蓝图，不改代码。落地按 §7 分期执行，每一期应可独立验证。

---

## 0. 判定：冲突在产品主模型，不在缺几个功能

| | OpenMAIC（底座） | LiveCourse（要求） |
|---|---|---|
| 产品主角 | 一键生成互动课，AI 老师和 AI 同学一起讨论 | Agent 成为老师，主动把一堂课教下去 |
| 课堂上谁开口 | 导演调度多名 Agent 轮流发言（圆桌） | 学生只与一位教师互动，其余 Agent 在台后 |
| 材料的位置 | 生成幻灯片/测验/互动即产品完成 | 材料为上课服务，生成完不是结束 |
| 课是否算上完 | 播完、讨论过 | 讲过、检查过、留下依据、决定下一步 |
| 工程重心 | 供应商生态、多语言、聊天应用接入、本地模型 | 教案、动作日志、证据、实时授课、课后可改 |

因此加减法不是「在 OpenMAIC 上再堆功能」，而是：

1. **保留**材料层（生成、场景、编辑、存储、导出）。
2. **减去**把产品拉回「多智能体圆桌 / 一键演示」的主路径。
3. **加上**教学控制层（教案、证据、台上教师、台后学情与评价）。

已写入 `lib/livecourse/` 的教案、动作日志、证据台账、全双工语音，是加法的起点，还没有取代 OpenMAIC 的课堂主路径。

---

## 1. 改造原则

1. **材料层保留，控制层重做。** 幻灯片 DSL、测验、互动、PBL、编辑器、存储不推倒。教学决策不写进生成提示词，写进 `lib/livecourse` 的领域契约。
2. **台上只留一位教师。** 助教、同学、圆桌讨论从默认课堂主路径撤下。需要扮演时（口语对方、职教情境）才启用情境 Agent。
3. **先改角色，再删文件。** `components/roundtable`、`lib/orchestration` 承载了播放与语音 UI，直接删除会拆课堂。先抽出口型/语音叠层，再去掉同学轮转。
4. **死代码立即删。** 无引用的依赖、已空的 OpenClaw 路径、临时截图目录不进入分期争论。
5. **新领域进 `lib/livecourse`。** 不把教案、支架、课程级调整散写进 `lib/generation` 或 `lib/orchestration`。

---

## 2. 加法不碰：必须保留的底座

这些是 OpenMAIC 留下、LiveCourse 上课仍需要的能力。改造时只改调用方式，不删模块。

| 层 | 路径 | 为什么留 |
|---|---|---|
| 场景契约 | `packages/@livecourse/dsl` | 幻灯片 / 测验 / 互动 / PBL 的共同文档 |
| 生成流水线 | `packages/@livecourse/generation`、`lib/generation`、`lib/prompts` | 大纲→场景内容→动作；插入「教学设计」步骤，而不是另起炉灶 |
| 导入 | `packages/@livecourse/importer`、`lib/import` | 课件进入与生成幻灯片相同的结构 |
| 渲染/导出 | `packages/@livecourse/renderer`、`lib/export`、`render-service` | 课后仍要能改、能导出、能再上 |
| 存储 | `packages/@livecourse/storage`、`lib/document-store`、`lib/persistence` | 浏览器默认、PostgreSQL 可选 |
| 播放 | `lib/playback`、`components/stage`、`components/scene-renderers` | 自动授课的时间轴；后续由课堂控制器驱动 |
| 编辑 | `components/edit`、`components/slide-renderer`、`lib/edit`、`lib/agent` | 课后维护；Edit-with-AI 保留给改课，不负责上课 |
| 白板 | `lib/whiteboard`、`components/whiteboard` | 板书是授课工具，不是演示彩蛋 |
| 测验评分 | `lib/quiz`、`app/api/quiz-grade` | 客观题与量规的写入点，对接证据台账 |
| PBL v2 | `lib/pbl`、`app/api/pbl/v2` | 仓库里最完整的「规划→授课→评价」示范，职教/项目课继续用 |
| 文档解析 | `lib/pdf`、`lib/media-parse`、`app/api/parse-pdf`、`extract-document` | 备课读资料 |
| 实时授课起点 | `lib/livecourse/*` | 已有教案派生、动作日志、证据投影、Realtime 网关、Airi 形象 |
| 供应商接入 | `lib/ai`、`lib/audio`、`lib/web-search`、`lib/server/provider-config.ts` | 保留可插拔，但从产品主叙事降为配置 |

---

## 3. 减法

分三类，避免把「该改角色的模块」当成垃圾删除。

### 3.1 立即删除（死代码 / 身份残留）

无产品争议，删了不改变上课能力。

| 对象 | 现状 | 动作 |
|---|---|---|
| `@copilotkit/backend`、`@copilotkit/runtime`、`copilotkit` | `package.json` 有依赖，源码零引用 | 从依赖移除 |
| `tsconfig.json` 的 `"openclaw"` exclude | 目录已不存在 | 删掉 exclude |
| `tmp/shots`、`tmp/pdfs`、chrome-profile | 本地截图与浏览器缓存，不是产品 | 保持 gitignore，不进仓库 |
| README / 文档站对 Lemonade、一键生成圆桌课的主推文案 | 身份已改名，叙事仍像 OpenMAIC | 改为「一位老师把课教完」 |

### 3.2 降级（从主路径撤到可选，默认不暴露）

能力可留在代码里，但不再作为 LiveCourse 的默认产品面。

| 对象 | OpenMAIC 中的角色 | LiveCourse 中的处理 |
|---|---|---|
| 十国语言包 | 社区产品面 | 开发与作品提交保留 `zh-CN`、`en-US`；`ar-SA` / `es-MX` / `fr-FR` / `ja-JP` / `ko-KR` / `pt-BR` / `ru-RU` / `zh-TW` 移出默认构建 |
| `packages/docs` 的 ar/ja/ru/zh-tw 镜像 | 文档站 i18n | 先只维护中英；否则架构文档永远写不完 |
| Lemonade / FunASR / Ollama 作为 README 亮点 | 本地 AI 生态 | 保留 provider 实现，文档降为「可选本地接入」 |
| 搜索/图像/视频/ComfyUI 供应商矩阵 | 材料生成的广度 | 备课需要时调用；首页不再并列「联网/深度交互/职教」为三个产品 |
| HTML 离线导出作为主卖点 | 内网分发 | 保留实现，课堂包 ZIP / 可再编辑文档优先 |
| 职教 Task Engine 作为独立生成模式 | 第二条生成产品线 | 并入学科能力：职教走 PBL/procedural-skill，不再是与普通课并列的开关 |
| `app/eval/whiteboard` | 内部评测页 | 移出主应用路由，或仅开发环境可见 |
| CHANGELOG 的 OpenMAIC 版本新闻 | 上游发行说明 | 冻结为「迁入基线 v0.3.1」，之后只记 LiveCourse 变更 |

### 3.3 改角色（不能直接删）

这些文件今天仍撑着课堂，但行为与「台上一位教师」冲突。

| 对象 | 冲突 | 改造目标 |
|---|---|---|
| `lib/orchestration` 导演图 + 默认 Agent 名册 | 默认五名上台：教师、助教、显眼包、好奇宝宝、笔记员；用户消息由导演轮转发言 | 名册默认只注册授课教师。导演改为课中环节切换（讲授 / 检查 / 情境），不再调度同学抢话筒 |
| `components/roundtable`、`lib/types/roundtable.ts`、`lib/chat` | 圆桌是课中主交互 | 拆成「教师语音叠层 + 学生插话输入」。讨论结束态、Your Turn、多参与者气泡退出主路径 |
| `app/api/generate/agent-profiles` | 按课生成一群同学 | 默认只生成教师画像；同学配置改为可选，且不进入实时发言 |
| `components/edit/PlaybackChromeRoot.tsx` | 播放壳与圆桌强耦合 | 播放壳对接 `ClassroomController` + 全双工教师，而不是 roundtable session |
| `app/api/chat`、`lib/orchestration` 的 SSE 讨论 | OpenMAIC 的实时讨论即课堂 | 课中主通道改为 `lib/livecourse/realtime`；文字 chat 仅用于课后编辑 Agent |
| LangGraph 的使用方式 | 用于多智能体圆桌轮次 | 保留库，改用于课前/课中/课后阶段切换，与作品简介 §4.5 一致 |

减法完成的验收：新生成的课堂默认只有一位教师开口；学生插话由该教师回应后回到原节点；助教/同学不再自动发言。

---

## 4. 加法

加法全部落在教学控制层。优先补「单堂课能教完并留下依据」，课程级与长期学情按作品简介发展规划后置。

### 4.1 必须补的领域契约

| 模块 | 建议路径 | 职责 | 深度要求 |
|---|---|---|---|
| CoursePackage | `lib/livecourse/domain/course-package.ts` | 一门课的目标、课时边界、知识先后 | 生成与规划 Agent 只通过它读写课程级结构 |
| TeachingAdjustment | `lib/livecourse/domain/teaching-adjustment.ts` | 复讲 / 推进 / 加练 / 追加课时的结构化提交 | 实时授课 Agent 不得直接改课程结构 |
| 支架状态机 | `lib/livecourse/domain/scaffold.ts` | 提示 → 示范 → 拆解 → 回退 → 撤除帮助 | 从对话习惯变成可测试的显式状态 |
| 学情摘要 | `lib/livecourse/domain/learner-summary.ts` | 当堂「会/不会/哪种讲法有效」 | 只进教师上下文，不对学生开口 |
| 学科 Skill 注册 | `lib/livecourse/skills/registry.ts` | 编程/数学/语言/职教的工具与评价挂载点 | 先规范，后搬迁 PBL 与 procedural-skill |

已有、需继续加深而不是重写：

- `LessonPlan` / `EvidenceRecord` / `GoalState` / `TeachingAction`
- `ClassroomController`、`action-repository`、`evidence-reducer`
- `LiveCourseRealtimeSession`、`tool-gateway`

### 4.2 必须补的 Agent 分工（与文件的对应）

作品简介要求「台上一位教师，台后学情与评价」。当前代码把备课、讨论、编辑混在生成流水线和导演图里。

| Agent | 何时工作 | 现有近似 | 要补的接口 |
|---|---|---|---|
| 资料理解 | 课前 | `extract-document` / `parse-pdf` | 输出结构化要点，而不是把原文塞进大纲 |
| 教学设计 | 课前，在生成内容之前 | 无独立步骤；大纲生成同时在做设计 | 写入 LessonPlan（目标、节点、检查点、证据规则） |
| 内容生成 | 课前，设计之后 | `outline-generator` + `scene-generator` | 只按教案生成材料，失败只重做该段 |
| 授课教师 | 课中唯一开口 | Realtime session + 播放引擎 + VRM | 短上下文：当前节点 + 目标 + 学情摘要 |
| 学情（台后） | 课中，插话/作答之后 | 无独立模块 | 更新学情摘要，不发言 |
| 评价（台后） | 检查点 / 项目提交 | `quiz/grading` + PBL evaluator | 只写 EvidenceRecord |
| 情境 | 仅扮演任务 | PBL simulator | 不讲解、不评分、不推进进度 |
| 编辑 | 课后 | `lib/agent` + Edit-with-AI | 改材料，不改证据历史 |
| 复盘 | 课后 | 无 | 输出可再使用的学情摘要 |

### 4.3 生成流水线要插入的缝（seam）

当前 OpenMAIC 流水线：

```
学习需求 / 资料 → 场景大纲 → 场景内容 → 讲解动作 → 播放
```

LiveCourse 流水线：

```
学习需求 / 资料
  → 资料理解
  → 教学设计（LessonPlan：目标、顺序、检查点、证据规则）
  → 场景内容（按节点生成材料）
  → 讲解动作
  → 课堂控制器按教案上课
```

改动落点：

- `lib/server/classroom-generation.ts`：在 outline 与 content 之间（或替换 outline 的职责）写入 LessonPlan。
- `packages/@livecourse/generation`：outline prompt 不再独自决定「这堂课是什么」；设计稿成为输入。
- `deriveLessonPlanFromStage`：从「生成后再反推教案」改为「先有教案再生成场景」。现有反推保留为导入旧课堂的适配器。

### 4.4 明确后置、本阶段不加

| 能力 | 原因 |
|---|---|
| BKT 掌握度模型 | 先用 GoalState 规则投影把单堂课跑通 |
| FSRS 复习调度 | 依赖多课时 CoursePackage |
| 摄像头课堂感知 | 隐私与本地处理未设计完；关闭后核心流程必须仍可用 |
| 跨设备 learner 合流 | 匿名档案已够单课堂演示 |
| 可解释「为什么重讲」面板 | 依赖支架状态机先存在 |

---

## 5. 文件级清单（按目录）

### 5.1 减法 / 降级

| 路径 | 动作 | 风险 |
|---|---|---|
| `package.json` 中 copilotkit 三依赖 | 删除 | 低 |
| `tsconfig.json` `openclaw` | 删除 | 低 |
| `lib/i18n/locales/{ar-SA,es-MX,fr-FR,ja-JP,ko-KR,pt-BR,ru-RU,zh-TW}.json` | 移出默认构建 | 中：需改 language-switcher 与 i18n 键检查 |
| `packages/docs/content/docs/*.{ar,ja,ru,zh-tw,zh-cn 镜像中的上游口吻}` | 文档站先中英；改 getting-started 叙事 | 低 |
| `lib/orchestration/registry/store.ts` 默认同学 Agent | 默认名册只留教师 | 中：生成/播放仍引用 participant |
| `app/api/generate/agent-profiles/route.ts` | 默认不生成同学 | 中 |
| `components/roundtable/*` | 拆分后删除圆桌主 UI | 高：先抽 `PresentationSpeechOverlay` |
| `app/eval/whiteboard/page.tsx` | 开发态或移入 eval/ | 低 |
| `CHANGELOG.md` 上游 News | 标注基线后不再累积 OpenMAIC 条目 | 低 |
| `comfyui-setup-instructions.md` | 移入 docs/optional 或删除主入口 | 低 |

### 5.2 加法（新文件，均在 `lib/livecourse`）

| 路径 | 内容 |
|---|---|
| `lib/livecourse/domain/course-package.ts` | 课程包契约与校验 |
| `lib/livecourse/domain/teaching-adjustment.ts` | 调整单契约；唯一课程结构写入口 |
| `lib/livecourse/domain/scaffold.ts` | 支架状态与合法转移 |
| `lib/livecourse/domain/learner-summary.ts` | 当堂学情摘要 |
| `lib/livecourse/agents/design.ts` | 教学设计：需求+资料 → LessonPlan |
| `lib/livecourse/agents/diagnostic.ts` | 台后学情，消费动作日志与证据 |
| `lib/livecourse/agents/review.ts` | 课后复盘 → 学情摘要 |
| `tests/livecourse/domain/*.test.ts` | 契约与状态机测试，不测 LLM |

### 5.3 改造（保留路径，改接口）

| 路径 | 改什么 |
|---|---|
| `lib/server/classroom-generation.ts` | 插入教学设计步骤 |
| `lib/livecourse/domain/lesson-plan.ts` | 成为生成输入，而不只是舞台派生产物 |
| `lib/orchestration/*` | 导演语义改为阶段切换 |
| `components/edit/PlaybackChromeRoot.tsx` | 主通道切到 ClassroomController + Realtime |
| `components/livecourse/*` | 教师面板成为课中主界面，而不是设置里的附加项 |
| `app/page.tsx`、`app/generation-preview/page.tsx` | 首页去「三种模式并列」；预览展示教案节点而不只是场景卡片 |
| `README.md` / `README-zh.md` / `packages/docs` | 叙事与加减法一致 |

---

## 6. 分层之后的目标结构

```
材料层（保留 OpenMAIC）
  dsl / generation / importer / editor / renderer / storage

教学控制层（LiveCourse 加深）
  LessonPlan · TeachingAction · EvidenceRecord · GoalState
  CoursePackage · TeachingAdjustment · Scaffold · LearnerSummary
  ClassroomController · Realtime teacher · Diagnostic · Evaluator

呈现层
  舞台场景 + 一位教师（VRM）+ 学生插话
  编辑态复用材料层编辑器
```

删除测试：若拿掉教学控制层，课堂应退回「能播的生成课」；若拿掉材料层，教师没有可教的东西。两层都有存在价值，不能互相替代。

---

## 7. 分期

| 期 | 目标 | 主要动作 | 验收 |
|---|---|---|---|
| 0 | 去掉死物 | 删 copilotkit、openclaw exclude；文档去圆桌主推 | 构建与测试仍过 |
| 1 | 台上一位教师 | 默认名册、agent-profiles、圆桌改角色；课中走 Realtime | 新课只有教师开口；插话后能回到节点 |
| 2 | 先设计再生材料 | 生成流水线写入 LessonPlan；反推仅用于旧课导入 | 每堂课先有目标与检查点，再有幻灯片 |
| 3 | 台后学情与评价 | diagnostic + 支架状态机 + 学情摘要进教师上下文 | 检查结果能改变下一步，且有依据 |
| 4 | 课程级 | CoursePackage + TeachingAdjustment | 第二课时能读第一课证据 |
| 5 | 长期学情与感知 | BKT/FSRS、档案合流、摄像头 | 按作品简介 §8，不阻塞前四期 |

---

## 8. 明确不做

- 不从零重写 Next.js 应用或幻灯片编辑器。
- 不把 OpenMAIC 的圆桌讨论「升级」成 LiveCourse 的课堂主交互。
- 不在本期引入 OpenClaw / 飞书 / Discord 生成课堂。
- 不把供应商数量当完成度。
- 不把 BKT、FSRS、摄像头当作单课堂闭环的前置。

---

## 9. 建议的下一步

先执行 **0 期 + 1 期的名册默认值**（低风险、能立刻改变产品形状），再动生成流水线。圆桌拆分因为耦合播放壳，单独开一轮，避免和契约加法缠在一起。

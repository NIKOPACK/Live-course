# LiveCourse 产品设计（组合完整版）

> 开发以 [docs/spec/](spec/00-index.md) 为准。本文是迁入时的对照笔记，不再当工作规格。

> 本文档基于《LiveCourse 作品简介》所描述的产品愿景与仓库当前代码的实际实现能力进行组合、核实与补齐，作为一份面向工程落地的完整产品设计。
> 文中标注【已实现】表示该能力在仓库中有对应的可运行实现；【部分实现】表示核心链路存在、边界或集成不完整；【设计未落地】表示仅存在于产品简介的愿景中，尚无对应代码。
> 本文件为独立新增文档，未改动任何原文件。

---

## 1. 产品定位

**LiveCourse 是一个面向真实课堂的多模态实时教学 Agent：让 Agent 成为老师，而不只是答疑工具。**

Agent 自主完成备课、组织多课时教学、课中提问与检查、响应学生打断，并基于学习证据持续调整后续教学安排。学生面对的不是一个输入框，而是一位能长期陪伴、逐步理解自己、并把整段课程教下去的专属老师。

与普通答疑 Agent 的对比：

| 对比维度 | 普通答疑 Agent | LiveCourse |
|---|---|---|
| 主动权 | 等待学生提出问题 | 主动备课、开课并推进教学目标 |
| 内容准备 | 依赖即时回答或用户材料 | 自主解析/检索、筛选并组织上课材料 |
| 课堂结构 | 围绕单个问题展开 | 围绕课程目标、教学节点和检查点组织课堂 |
| 学生插话 | 通常转入新的问答话题 | 暂停授课、即时回应，并恢复原教学节点 |
| 掌握判断 | 常以单次回答结束 | 依据证据规则、支架使用与迁移表现持续判断 |
| 长期连续性 | 会话结束后通常重新开始 | 持续调整后续课时、安排复习并积累学生档案 |

---

## 2. 用户角色与核心场景

| 角色 | 典型需求 | LiveCourse 如何满足 |
|---|---|---|
| 本科学生（专业课预习/补学/复习） | 围绕课程目标组织连续课时，参考学校资料与教学进度 | 上传课件/笔记，Agent 解析后生成多课时课程；课后依据学习证据调整后续安排 |
| 中学生 | 依据前置知识动态安排讲解、练习与复习 | 检查点 + 支架 + 目标状态，逐级提供帮助并回退/前进 |
| 语言学习者 | 连续口语课程 | 实时语音授课 + VRM 教师形象 + 发音/情境对话能力 |
| 职业教育/技能训练者 | 完成"讲解—练习—检查—调整"闭环 | PBL v2 项目式流程 + 任务引擎模式（职教任务） |
| 教师/教育机构 | 把资料整理、个别讲解、练习反馈交给 Agent | 保留教师对课程目标、内容与评价规则的控制权 |

---

## 3. 信息架构与主流程

### 3.1 用户主流程（当前已实现）

```
首页 /page
  │  输入学习需求（可选昵称/简介/语音输入）
  │  上传课程资料（PDF/PPTX/文档，多文件去重排序）
  │  可选：联网搜索、互动模式、职教任务模式
  ▼
生成预览 /generation-preview
  │  流式生成场景大纲（outlines）
  │  逐场景生成内容（幻灯片/测验/互动/白板/PBL）
  │  生成后进入可视化编辑器
  ▼
课堂 /classroom/:id
  ├─ 舞台：当前场景渲染（幻灯片/测验/互动网页/白板/PBL）
  ├─ 左轨：场景缩略图与导航、课堂记录/讨论
  ├─ 右侧：AI 教师形象（VRM）+ 学习目标状态 + 实时语音控制
  └─ 播放引擎：自动授课（讲解→提问→效果动画→检查点）
  ▼
编辑 /classroom/:id（同页切换编辑态）
  ├─ 幻灯片画布编辑器（元素选择/文本/图形/图片/表格/图表/代码/LaTeX/视频）
  ├─ 测验表单编辑器（题型/答案/评分）
  ├─ 生成 Agent 面板（重新生成场景/编辑元素/读场景）
  └─ 角色名册（Agent 头像/提示词/语音配置）
  ▼
导出 / 渲染
  ├─ 课堂导入导出（.zip 课堂包 / PPTX）
  ├─ MP4 渲染（render-service 独立服务）
  └─ 云上持久化（PostgreSQL profile，可选项）
```

### 3.2 核心闭环：教学状态流

产品简介提出的"可追溯教学状态"已由领域契约落地：

| 阶段 | 主要产物 | 写入边界与下游用途 | 实现状态 |
|---|---|---|---|
| 课程构建 | CoursePackage、LessonPlan | 课程规划与备课 Agent 写入，定义目标、规则和课时边界 | 【部分实现】LessonPlan/Goal 契约已落地，CoursePackage 为规划目标 |
| 现场课堂 | LessonEvent、BoardCommand | 实时授课 Agent 写入，记录讲解、提问、打断和工具动作 | 【已实现】TeachingAction + BoardCommand 动作总线 |
| 证据沉淀 | EvidenceRecord、GoalState | 证据规则更新，保存作答、支架使用和目标状态 | 【已实现】evidence-reducer 按规则投影 GoalState |
| 课程调整 | TeachingAdjustment、新 LessonPlan | 课程规划 Agent 提交，决定复讲、推进、练习或追加课时 | 【部分实现】调整决策由 Agent 对话驱动，结构化 TeachingAdjustment 契约待开放 |

---

## 4. 功能模块设计

### 4.1 课前：自主备课与课程规划

**目标能力（简介）**：学生只需说明学习需求（主题、目标、已有基础、时间安排）并可上传资料；Agent 解析资料、检索核验材料、制定课程方案（总体目标、知识点及前置关系、课时安排、复习节点、评价方式），再生成教案（讲解顺序、板书、提问方式、检查点、证据规则、常见错误、可用工具）。

**实际实现能力**：

| 能力 | 实现 | 状态 |
|---|---|---|
| 需求输入 | 首页统一输入框 + 草稿缓存；可语音转写填入；昵称/简介作为个性化上下文 | 【已实现】 |
| 课程资料上传 | 多文件上传、按 MIME 规范化、去重排序、浏览器 blob 暂存 | 【已实现】 |
| 文档解析 | PDF（MinerU 云解析 / 阿里云 DocMind 双供应商）、图片、视频供应商核验；文档 → 可生成结构（extract/parse-pdf） | 【已实现】 |
| PPTX 导入 | importer 包（pptxtojson + 自定义序列化）把 PPTX 解析映射为幻灯片 DSL；前端入口受特性开关控制 | 【部分实现】解析能力强，端到端入口仍为脚手架 |
| 联网检索核验 | 多供应商 web-search（Brave/Tavily/SearXNG/Baidu/博查/Doubao/MiniMax/Claude 等）+ 来源引用（source.show 动作） | 【已实现】 |
| 场景大纲生成 | outline-generator 流式产出教学场景大纲，支持中途单场景重试 | 【已实现】 |
| 多课时课程规划 | 首页一次生成一个课堂；多课时动态课程序列（简介愿景） | 【设计未落地】详见 §7.3 |

### 4.2 课中：按教案授课与实时交互

**目标能力（简介）**：Agent 以教师身份主动组织讲解、演示、提问和练习；学生可随时打断，Agent 暂停并记录教学节点，回应后恢复；讲师的声音、口型、表情、动作、板书、题目由同一教学事件同步驱动。

**实际实现能力**：

| 能力 | 实现 | 状态 |
|---|---|---|
| 场景渲染 | 四类场景：幻灯片 / 测验 / 互动网页 / PBL 项目，白板作为独立画布 | 【已实现】 |
| 播放引擎 | `lib/playback/engine.ts`：autonomous/playback/edit 三种模式；播放中触发讲解、提问、白板书写、激光/聚光灯效果、讨论话题、检查点开合；支持动作导航与自动续播（含会话恢复） | 【已实现】 |
| 教学动作契约 | `TeachingAction` 二十余种动作：lesson.pause/resume/goto_node、stage.highlight/pointer、board.apply/clear、avatar.expression/gesture/look_at/speech_start/end、checkpoint.open/submit/close、source.show | 【已实现】 |
| 幂等事件日志 | `action-repository`：教学动作以 append-only 顺序日志持久化，序列校验 + 幂等键 + 冲突重试，可折叠出恢复点（currentNodeId/lastSequence） | 【已实现】 |
| 课堂控制器 | `ClassroomController`：串行 dispatch（先呈现→后提交→再发布），重复动作幂等返回，中断后可恢复 | 【已实现】 |
| 全双工实时语音 | `LiveCourseRealtimeSession` + `RealtimeAudioBridge`：实时语音服务（OpenAI Realtime 系），教学上下文注入（当前节点/场景/目标/备课内容），支持打断（interrupt）、静音、节点恢复（resumeNode） | 【已实现】 |
| 实时工具网关 | `tool-gateway`：白名单工具（goto_node/highlight/pointer/board_text/board_clear/set_expression/look_at/show_source），zod 严格 schema 校验，映射为教学命令，callId 派生幂等键 | 【已实现】 |
| AI 教师形象 | `airi-vrm-element`：基于 three-vrm + VRM 动画加载 VRM 模型；表情/口型/视线（student/slides/whiteboard/camera）；音频经 AnalyserNode 驱动口型；`TeacherAvatarHost` 提供教师面板（讲解中/思考中/待机、当前目标、证据计数） | 【已实现】 |
| 教师形象回退 | 非 WebGL 环境使用静态教师形象（teacher.png） | 【已实现】 |

### 4.3 检查与调整：讲过的知识要验证掌握

**目标能力（简介）**：每个关键知识点设检查点；检查形式多样；不仅判断对错，还记录是否独立完成、是否用提示、错在哪一步、能否迁移；未达标时逐级提供帮助（缩小范围→同类示范→拆分讲解），成功后逐步撤除帮助并提高难度；每次调整必须有依据。

**实际实现能力**：

| 能力 | 实现 | 状态 |
|---|---|---|
| 检查点动作 | checkpoint.open / submit / close，随播放引擎在节点上触发 | 【已实现】 |
| 测验评分 | quiz/grading：确定性评分 + 模型量规评分双轨；低置信度进入"证据不足"待复核（evidence 状态机 pending_review → approved/rejected） | 【已实现】 |
| 证据契约 | EvidenceRecord：来源（检查点/作业/教师复核）、类型（客观/量规/自述）、标准化分数、评估方法（deterministic/model/human）、幂等键；自述证据不可直接作为掌握证明 | 【已实现】 |
| 目标状态投影 | evidence-reducer：按 GoalRule（通过分/最少证据数/最少通过数）把证据折叠成 GoalState（not_started/in_progress/met/needs_support），附带 accepted/pending/passing 计数与最新/平均分 | 【已实现】 |
| 支架决策 | 简介所述的"逐级帮助→撤除帮助"状态机 | 【部分实现】Agent 对话中的支架行为存在，独立"教学决策与支架状态机"契约尚未开放 |
| 迁移表现记录 | EvidenceRecord.metadata 可承载迁移任务结果 | 【部分实现】字段具备，迁移判定逻辑未独立成模块 |

### 4.4 课后：长期学情与持续调整

**目标能力（简介）**：课堂与作业数据进入同一套学习记录；综合掌握状态、错因、复习到期时间重新评估未完成内容；课程级调整包括重排知识点、插入补课、增加巩固课、合并已掌握内容、调整作业与复习节点、修改总时长；BKT 追踪掌握概率、FSRS 安排复习时间、长期档案保存错因/支架轨迹/有效讲法。

**实际实现能力**：

| 能力 | 实现 | 状态 |
|---|---|---|
| 统一学习记录 | 证据（EvidenceRecord）与教学动作（TeachingAction）同一运行时存储（IndexedDB/PG），按课程+学习者分区 | 【已实现】 |
| 长期学生档案 | 设备匿名 learnerKey（anon:*）分区运行数据；用户昵称/简介/头像档案；Agent 生成名册与配置随课堂持久化 | 【部分实现】匿名学习者档案已落地，跨设备/登录账号的档案合流（mergeLearner）为预留迁移路径 |
| BKT 掌握度追踪 | 简介核心愿景 | 【设计未落地】当前掌握判定为规则型 GoalState 投影，非 BKT 概率模型 |
| FSRS 复习调度 | 简介核心愿景 | 【设计未落地】无独立实现 |
| 复习节点 | 简介提及将到期知识放入后续作业/课程节点 | 【设计未落地】无独立实现 |
| 课程级重排 | 简介核心闭环 | 【部分实现】见 §7.3 |

### 4.5 学科扩展与多 Agent 组织

**目标能力（简介）**：通用教学底座（实时语音、课程状态、教师形象、课堂感知、支架决策、BKT/FSRS、长期档案）+ 学科 Skill（编程需代码执行、数学需公式推导、语言需发音分析、人文需材料分析）。

**实际实现能力**：

| 能力 | 实现 | 状态 |
|---|---|---|
| Agent 名册 | 生成式课堂产出 Agent 配置（名称/角色/人格/头像/颜色/优先级/语音绑定）；编辑器内角色面板可调整 | 【已实现】 |
| 多 Agent 对话编排 | `lib/orchestration`：director-graph + prompt-builder + ai-sdk-adapter；每轮用户消息由导演调度多个 Agent 顺序作答，直到导演判定 END | 【已实现】 |
| Agent 工具集 | `lib/agent/tools`：编辑元素、编辑互动 HTML、读场景内容、重新生成场景动作/内容；allowlist + 参数 schema + 配额（quota） | 【已实现】 |
| 通用教学底座 vs 学科 Skill | 抽象上由 Agent 编排 + 场景类型承载；尚未形成"学科 Skill 注册/规范"形式 | 【部分实现】 |
| 代码执行/数学推导等学科能力 | 依赖互动场景（code/simulation 等 widget）+ 外部工具 | 【部分实现】场景具备，学科能力包未独立 |

### 4.6 项目式学习（PBL v2）

**PBL v2 是仓库中实现最完整的多 Agent 教学闭环**，可作为"完整课堂"的示范实现：

| 能力 | 实现 |
|---|---|
| 四类 Agent | planner（单次调用/多步规划）、instructor（授课与工具调用）、simulator（情境模拟叙述）、evaluator（里程碑/任务/最终评价） |
| 自适应熟练度引擎 | `operations/kernel/proficiency.ts`：三阶段证据驱动评估（planner 静态信号 → 课前测验快照 → 运行时动态信号），EWMA 聚合 + 滞后/冷却防抖动；**熟练度全部为确定性代码而非 LLM 提示** |
| 学习进度内核 | progress/runtime-events/engagement/task-completion：事件溯源 + 里程碑/微任务完成判定 + 完成统计 |
| 运行时 | 学习者在工作区提交任务、Instructor 记录观察、关闭检查、强制推进；文档持久化与任务恢复（clone/drain/hydration/fold） |
| 前端场景 | scenario-briefing（情境简报门控）、hero、workspace、submission、completion、agent-tabs、评分卡片（星级/里程碑/完成 CTA） |
| 对外接口 | `/api/pbl/v2/{instructor,open-task,evaluate,simulator}` + SSE 流式指令 |
| 评价体系 | eval/pbl-v2-planner 用例 runner 对比规划质量 |

### 4.7 生成式内容与可视化编辑器

| 能力 | 实现 | 状态 |
|---|---|---|
| 场景类型 | slide / quiz / interactive / pbl 四类；互动 widget：simulation、diagram、code、game、visualization3d、procedural-skill | 【已实现】 |
| 幻灯片元素 | 文本/图形/线条/图片/表格/图表（ECharts）/代码（Shiki）/LaTeX（KaTeX/temml）/视频，含蒙版、滤镜、裁剪 | 【已实现】 |
| 可视化编辑器 | 画布选择/拖拽/旋转/缩放/对齐、元素拾取层、背景控制、吸色、多选操作；ProseMirror 富文本 | 【已实现】 |
| 测验编辑器 | 题型增删改、答案与评分配置、公式支持 | 【已实现】 |
| 生成 Agent 面板 | 就地编辑元素、重新生成场景、读场景内容、撤销/恢复 | 【已实现】 |
| 多页导航 | 幻灯片缩略图轨道、插入/删除/重排、多标签编辑冲突提示 | 【已实现】 |

### 4.8 课堂感知、语音与多模态

| 能力 | 实现 | 状态 |
|---|---|---|
| 摄像头课堂感知 | 简介：本地提取注视/低头/转头等粗粒度信号 | 【设计未落地】无对应实现 |
| 实时语音 | OpenAI Realtime 系全双工，客户端临时凭证（client-secret），音频桥接 | 【已实现】 |
| TTS 语音 | 多供应商 tts-providers + VoiceDesign 三层声音描述（身份/质感/表达）→ 注册/克隆/预览 | 【已实现】 |
| ASR 语音识别 | 多供应商 asr-providers（transcription 接口） | 【已实现】 |
| 图像/视频生成 | 多供应商 image-providers / video-providers + ComfyUI 工作流；媒体编排器按大纲生成 | 【已实现】 |
| 媒体资产管理 | asset-pool、media-task 恢复、占位符回收、跨课堂隔离 | 【已实现】 |

### 4.9 导出、持久化与安全

| 能力 | 实现 | 状态 |
|---|---|---|
| 课堂包导出/导入 | .zip 课堂包（含媒体内联、HTML 解析、引用代理）；PPTX 导出 | 【已实现】 |
| MP4 渲染 | 独立 render-service（Docker），HTTP 任务化渲染，字幕与超帧；前端导出对话框 + 能力探测 | 【已实现】 |
| 存储 | browser（IndexedDB）默认；PostgreSQL 可选；document/runtime/kv/asset 四类适配器（byte-store + S3/PG bytes） | 【已实现】 |
| 准入 | access-code 访问码（课堂访问控制） | 【已实现】 |
| 隐私 | 摄像头画面本地处理为愿景；实时音频仅流经浏览器与服务间；转写是否保存由用户选择 | 【部分实现】 |
| 服务端安全 | API 密钥仅存服务端；上传按不可信输入处理；工具 allowlist + schema；评分可复核；外部知识记录来源 | 【已实现】 |

---

## 5. 核心数据契约（领域模型）

### 5.1 LessonPlan（教案）

- **schemaVersion/id/courseId/stageId/title/version/status/createdAt**
- **goals[]**：LearningGoal（id、title、description、rule）
  - **rule**：GoalRule（passScore、minAcceptedEvidence、minPassingEvidence、version）
- **nodes[]**：LessonNode（id、sceneId、title、type：`instruction|checkpoint|interactive|project`、order、goalIds）
- 校验：goalId 全局唯一；node.sceneId 唯一；node.goalIds 必须引用已声明目标
- 由 `deriveLessonPlanFromStage` 从舞台场景派生：quiz 场景 → checkpoint 节点 + 每场景一个学习目标；其余归并为 instruction/interactive/project

### 5.2 EvidenceRecord（证据）

- 来源：`checkpoint|homework|teacher_review`；类型：`objective_score|rubric_score|self_report`
- 状态：`accepted|pending_review|rejected`；标准化 score ∈ [0,1]
- 评估方法（discriminated union）：
  - deterministic：方法 + 规则版本
  - model：模型 id + 量规版本 + 输入摘要 + 置信度 + 复核状态
  - human：复核人 + 量规版本
- 约束：accepted/pending 必须有分数；self_report 不得被接受为掌握证据；model 复核状态与 evidence 状态联动
- 幂等：id / idempotencyKey 双重唯一，冲突即拒绝

### 5.3 GoalState（目标状态投影）

- status：`not_started|in_progress|met|needs_support`
- 统计：evidenceIds、acceptedEvidenceCount、pendingReviewCount、passingEvidenceCount、latestScore、averageScore
- 判定（evidence-reducer）：达到 minAcceptedEvidence 且通过数达 minPassingEvidence → met；证据达标但通过不足 → needs_support；否则 in_progress

### 5.4 TeachingAction（教学动作）

- 信封：schemaVersion/id/courseId/lessonId/nodeId/sequence/timestamp/idempotencyKey
- 类型见 §4.2；播放引擎消费并驱动舞台（高亮、激光、聚光灯、白板、检查点、教师形象）

### 5.5 舞台 DSL（Stage/Scene/SceneContent）

- SceneType：slide / quiz / interactive / pbl；StageMode：autonomous / playback / edit
- 白色板书（Whiteboard = Slide 子集）、互动内容（html/url + widgetType）、语音设计（VoiceDesign：identity/texture/delivery）、Agent 语音绑定（AgentVoiceConfig）
- 生成 Agent 配置内嵌于舞台文档（generatedAgentConfigs），客户端无需依赖 IndexedDB 预填充即可水合 Agent 名册

---

## 6. 系统架构与 Agent 组织

### 6.1 分层

```
┌─ 前端（Next.js App Router，React 19）
│   app/              页面（首页、生成预览、课堂、设置、评估白板）
│   components/       舞台、编辑器、场景渲染器、教师形象、设置面板
│   lib/store+contexts zustand 客户端状态 + 课堂会话上下文
│
├─ 领域逻辑
│   lib/livecourse/   教案派生、教学动作日志、课堂控制器、实时会话、证据台账
│   lib/orchestration/ 导演式多 Agent 编排、AI SDK 适配
│   lib/agent/         Agent 工具注册/许可/配额
│   lib/pbl/           PBL v2 项目式学习内核与四类 Agent
│   lib/playback/      播放引擎（autonomous/playback/edit）
│
├─ 内部包 packages/@livecourse/
│   dsl           舞台/场景/动作/存储契约（schema + 校验 + 版本）
│   generation    大纲与场景生成流水线（含 PBL planner）
│   importer      PPTX 解析与序列化为幻灯片 DSL
│   renderer      HTML 快照渲染（MP4 超帧前置）
│   storage       运行时/文档/KV/资产四类适配器（browser/PG/HTTP）
│
├─ 服务端 API（app/api）
│   generate/*    大纲流式、场景内容、图片、视频、TTS、语音、Agent 配置
│   chat, chat/pi  AI 对话与工具编排
│   realtime/*     client-secret、实时工具网关
│   pbl/v2/*       Instructor 流、任务开启、评估、情境模拟
│   export-video/* MP4 渲染任务（对接 render-service）
│   persistence/*  云上持久化代理
│
└─ 独立服务
    render-service/  MP4 渲染（Docker 隔离）
```

### 6.2 多 Agent 分工（与简介对照）

| 简介中的 Agent/模块 | 代码中的对应 | 状态 |
|---|---|---|
| 课程规划 Agent（课程级安排） | PBL planner、outline-generator、场景大纲 | 【部分实现】单课时级已实现，课程级多课时规划待落地 |
| 备课 Agent（材料+教案+检查点） | generation 流水线 + scene-generator + 文档解析 | 【已实现】 |
| 实时授课 Agent（低延迟、最小上下文） | LiveCourseRealtimeSession + tool-gateway + ClassroomController | 【已实现】 |
| 感知融合模块（视觉/语音/作答/操作 → 课堂状态假设） | 作答/语音信号进入 teachingContext；摄像头感知缺失 | 【部分实现】 |
| 学情与作业 Agent（BKT/FSRS/错因/档案，须引用证据） | EvidenceRecord/GoalState 证据台账 + runtime-repository | 【部分实现】BKT/FSRS 未实现 |

### 6.3 课程与课堂的两级结构

- **课程级（course）**：目标、知识依赖、课时结构、复习计划 —— 简介愿景，多课时规划未落地（§7.3）
- **课堂级（lesson）**：当前课时的教案（LessonPlan）+ 场景序列 + 教学动作日志 —— 已实现
- **写入边界**：实时授课 Agent 只读取教案、产生课堂事件；单次评分先写 EvidenceRecord，再经规则投影 GoalState；课程规划 Agent 只在有足够证据时才提交课时调整 —— 该"唯一写入入口"原则已体现在 action-repository 的分区与幂等设计中

---

## 7. 产品简介愿景 vs 当前实现差距分析

### 7.1 已完整实现、可对外宣称的能力

1. 从提示词/上传文档生成结构化课程（大纲→场景→教案派生）
2. 四类课堂场景（幻灯片/测验/互动网页/PBL）+ 白板
3. 播放引擎：自动授课、效果动画、检查点、话题讨论、断点续播
4. 教学动作日志：可审计、可恢复、幂等
5. 证据台账：可追溯、可复核、规则投影目标状态
6. 全双工实时语音授课 + 打断与节点恢复
7. VRM 教师形象（表情/口型/视线/手势）与教学事件同步
8. 多供应商多模态服务编排（LLM/ASR/TTS/图片/视频/Web 搜索/文档解析）
9. PBL v2 完整项目式学习闭环（规划→授课→模拟→评估→自适应熟练度）
10. 可视化编辑器 + 生成 Agent 工具化编辑
11. 课堂包导入导出、PPTX 导入/导出、MP4 渲染
12. 浏览器/PostgreSQL 双存储、访问码准入、评分复核

### 7.2 部分实现、需说明边界的能力

| 能力 | 现状 | 缺口 |
|---|---|---|
| 支架教学 | 存在于 Agent 对话行为中 | 独立"支架状态机"契约未开放 |
| 长期学生档案 | 设备匿名档案已落地 | 跨设备/登录账号合流未上线 |
| 学科 Skill | 以 Agent + 场景承载 | 学科 Skill 注册规范未形成 |
| 摄像头课堂感知 | 无 | 本地信号提取与教学动作映射待建设 |
| 迁移表现判定 | 证据 metadata 可承载 | 独立迁移判定模块未落地 |

### 7.3 仅存在于简介愿景、尚无实现的能力（路线图）

> 这些正是简介中"完整教学闭环"与当前实现的最大差异，建议作为产品路线图优先项。

1. **多课时动态课程序列**：初始课程方案（总体目标、知识点前置关系、课时安排、复习节点、评价方式）+ 基于证据的持续重排（压缩已掌握、插入前置补课、增加巩固课、合并内容、重新估算进度）。
2. **课程级 Agent**：课程规划 Agent 的独立模块，负责课程级调整的提交与版本化（TeachingAdjustment 契约开放）。
3. **BKT 掌握度追踪**：贝叶斯知识追踪概率模型（当前为规则型 GoalState）。
4. **FSRS 复习调度**：遗忘曲线复习时间安排 + 复习节点编排。
5. **教学决策与支架状态机**：继续/追问/提示/示范/拆解/回退/提高难度的显式状态机。
6. **摄像头课堂感知**：注视/低头/转头/离开等粗粒度信号 → 课堂状态假设 → 教学动作。
7. **感知融合模块**：视觉+语音+作答+操作的多源信号融合，作为辅助信号不直接判掌握。

### 7.4 建议的落地顺序

| 阶段 | 内容 |
|---|---|
| 一期（当前已具备） | 单课堂生成、播放、编辑、实时授课、证据台账、PBL v2、导出渲染 |
| 二期 | 多课时课程规划 Agent + 课程级调整闭环；TeachingAdjustment 契约开放；支架状态机 |
| 三期 | BKT 掌握度模型 + FSRS 复习调度；长期学生档案跨设备合流；学科 Skill 规范 |
| 四期 | 摄像头课堂感知 + 感知融合；教学决策的可解释面板（"为什么重讲/重排/此时复习"） |

---

## 8. 非功能设计

### 8.1 隐私与数据最小化（对照实现）

| 数据 | 设计要点 | 实现状态 |
|---|---|---|
| 摄像头原始画面 | 仅本地处理，可关闭；关闭后仍可完成核心流程 | 【设计】待实现 |
| 实时音频 | 浏览器与实时语音服务间；应用侧不保存；使用前说明云处理范围 | 【已实现】临时凭证、应用侧不落盘 |
| 完整课堂转写 | 默认不长期保存；主动开启才保存，可查看/导出/删除 | 【已实现】由用户选择 |
| 课程资料及解析块 | 按用户和课程隔离；可导出和级联删除 | 【已实现】资产回收 + 级联清理 |
| 作答/评分/教学调整 | 证据台账持久化；可查看并申请复核；删除课程一并清理 | 【已实现】 |
| 学习者身份 | 设备匿名键（anon:*）；登录后 mergeLearner 迁移 | 【已实现（匿名）/ 待实现（合流）】 |

### 8.2 安全控制（已实现）

- API 密钥仅服务端；浏览器用临时凭证连实时语音
- 上传资料一律按不可信输入处理，不执行其中的提示/脚本/宏
- 工具调用 allowlist + 参数 schema；课堂命令绑定课程/课时/节点/顺序，不接受任意代码执行
- 客观评分器与开放式量规分开；低置信度进入"证据不足"，允许复核
- 外部知识记录来源与检索记录；无可靠依据时说明缺口

### 8.3 可观测与可复现

- eval/ 评价体系：PBL 规划质量、白板布局、大纲语言、编排回答质量等 runner
- e2e（Playwright）+ vitest 单元覆盖存储/领域契约
- 运维脚本：importer 同步校验、MinerU 探测、生成节点冒烟、i18n 键检查、Prettier 格式检查

---

## 9. 开源与生态计划（简介要求，作为设计目标）

- 核心数据契约开放：CoursePackage、LessonPlan、EvidenceRecord、GoalState、TeachingAdjustment、BoardCommand、课堂事件协议、工具契约、BKT/FSRS 适配接口、多模态感知适配接口、学科 Skill 规范
- 示范单元 + 模拟课堂事件 + 回放与验证脚本 + 从零运行说明
- 稳定阶段对契约版本化管理（标签/变更日志/兼容测试/迁移说明）
- 社区共建：Issue/Discussion/PR 接收学科 Skill、课程包、适配器、测试用例
- 公开仓库不含真实学生数据、上传资料、服务密钥、完整课堂记录

---

## 10. 结语

LiveCourse 的差异化不在于"答得更好"，而在于**对整个教学过程负责**。当前仓库已经把这条闭环的地基打得很扎实：从教案契约、可审计教学动作、可追溯证据台账，到全双工实时授课与 VRM 教师形象、再到 PBL v2 这个完整的"规划—授课—评估—调整"示范单元。

产品简介所描绘的完整愿景——多课时动态课程、BKT/FSRS 长期学情、支架状态机、课堂感知——是清晰且可落地的路线图。建议按 §7.4 的分期推进：先把已实现的能力打磨为可对外展示的教学闭环，再逐步补齐课程级规划与长期学情这两块最重的拼图。当 Agent 能持续对课程目标、课堂过程和后续安排负责时，AI 才真正成为能长期陪伴学生、逐渐理解学生的老师。

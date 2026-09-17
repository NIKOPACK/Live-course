# 详细设计

按模块写**接口与缝**。每条缝先标：沿用 / 改角色 / 待撤 / 才新写。

依据：[03-product-design.md](03-product-design.md)。实现落点见 [05-development-plan.md](05-development-plan.md)。

新领域只进 `lib/livecourse/`。不把教案、学情、支架写进 `lib/generation` 或 `lib/orchestration`。

## 1. 课堂主通道 — 改角色

接口：课堂控制器串行执行教学动作；Realtime 教师是唯一开口；播放壳消费控制器，不消费圆桌 session。

- 沿用：`lib/livecourse/session/controller.ts`、`lib/livecourse/realtime/`、`lib/playback/`
- 改角色：`components/edit/PlaybackChromeRoot.tsx` 接到 `ClassroomController` + Realtime，不再驱动多名 Agent 轮转
- 才新写：播放壳把 Realtime transport 的语音转写增量事件（`response.output_audio_transcript.*`，兼容文本输出事件）与输入识别结果投影为只读实时字幕——教师讲授字幕与学习者插话识别回显。字幕经独立订阅 store 渲染（不进课堂 context 主状态），不进入动作总线、不持久化、不产生证据；语音课堂使用上游支持的 audio 输出模态及其转写事件，不同时请求互斥的 audio / text 模态。字幕事件不可达时字幕静默缺省，不改变任何状态机迁移
- 待撤：`components/roundtable` 的同学气泡与 Your Turn。圆桌仍撑着部分播放 / 语音 UI，先抽教师语音叠层，再去掉同学轮转。禁止整目录直接删除。
- 改角色：课堂壳只向控制器发类型化命令：进入节点、自然插话、提交答案、暂停、继续、重听已讲部分、重试当前节点、明确「暂时离开课堂」。命令必须从明确 UI / 语音事件进入，播放游标、加载回调、浏览器返回与标签卸载不能直接写“已讲 / 已掌握”或宣告成功离开
- 才新写（A2）：课堂状态机明确 `loading / teaching / interrupted / checking / paused / replaying / completed / finalizing / failed`；失败保持原状态和恢复点，不推进节点。必要检查未产生有效证据时不得迁移到 `completed`
- 才新写（A2）：新增权威、类型化、幂等的节点讲授完成事件 schema `lesson.complete_node`（**现有 schema 尚无此事件，A2 才新写，不得假称沿用**），至少携带稳定 idempotency key、`classroomSessionId`、`courseId`、`nodeId` 与已成功结束的 speech / action 引用。只有教师 speech 与 action 都报告成功结束后，控制器才可提交；媒体播放到达或加载回调无权提交
- 才新写（A2）：`lesson.complete_node` 去重后先更新 `W`，并由同一协调器立即持久化 `C.completedNode / C.progress`。该事件不创建 `EvidenceRecord`、不投影 `GoalState`、不表示掌握。最后一个必需讲授节点提交成功，或最后一个必要检查已有有效 evidence，且它补齐最后尚缺的必需动作时，唯一迁移为 `completed → finalizing → J4.1`
  - 完成事件已持久化而完成门读取失败时，同 key 重试仍重评完成门；新协调器加载持久化完成进度后也恢复该门，不重复写完成事件或进度。暂停 / 重听期间仍沿用原状态门禁。
- 才新写（A2）：提交答案、重试节点、暂停 / 继续、`saveAndLeaveSession` 与 `finalizeSession` 带稳定 idempotency key。判分重试复用同一次提交，`EvidenceRecord` 只 append 一次；重听和媒体重试永不产生 evidence
- 选择题答案以选项 `value` 为准；模型或旧文档给出选项文字时，只允许唯一匹配的 `label` 转换为 `value`，合法标识优先，不做语义猜测。生成、文档读取与本地判分共用 DSL 归一化；未知、歧义或无可用答案的生成题目失败并沿用单段重试。判分错误留在可见失败态，不生成分数、review 或 evidence，不改写已提交的历史成绩。
- 才新写（A2）：未完成课堂只由「暂时离开课堂」调用幂等 `saveAndLeaveSession`：显示保存中，成功时严格先写 `C` 恢复点、再销毁 `W`、最后导航首页；任一步保存失败都留在课堂可重试。浏览器 / 标签卸载只允许 best-effort 保存，不算成功状态迁移
- 才新写（A2）：唯一 `finalizeSession` 在进入 `finalizing` 后幂等归档 `W → C`、把合法 learner-only candidate 经 policy 写 `L`；全部成功后才销毁 `W` 并进入课后选择。失败停在 `finalizing`、保留 `W` 与待归档状态并显示重试。J4.3「离开」仅导航，不得再次调用保存 / 归档 / 销毁
  - C 的可选 `lifecycle.finalization` 使用 `version: 1`，保存固定归档 key 与 `pending / memory-finalized` 阶段；归档先写 pending，C/L 全部完成后先持久化 memory-finalized，再清理 action W 与 working-memory W。阶段确认版本不算再次归档，销毁 W 后不再尝试必要的 C/L 或阶段写入；阶段确认失败后重试沿用原归档时间，避免重复刷新同一 learner 贡献的时间戳。
  - 重新打开课堂时校验原归档身份并检查两份 teaching W，不计 replay W。memory-finalized 且两份 W 都缺席才进入课后；残留 W 或 pending 只恢复同一 finalizing，不挂载教学 Stage、不启动教学动作。旧 archived 无阶段字段也必须定位原 W 并确认两份都缺席；未知原归档身份、读取失败或恢复资料缺失均显示可重试错误，不静默当作完成。
  - 上述归档恢复仅属于普通课堂入口；`?replay=1` 与 replaySession 遇到未完成归档必须加载失败并允许返回原选择态，不得转为教学 / finalization，不写 C/L，也不创建 teaching W。
- 才新写（A2）：首页同课「继续」是 teaching 恢复生命周期且只对未完成 `C` 可用：加载同一 `C + L` 成功后新建 teaching `W` 并恢复持久化未完成位置，绝不恢复旧 `W`。加载失败留在首页同课选择态，不新建课程，也不得退化为 replay；已完成 `C` 拒绝「继续」
  - 教学入口优先恢复持久化教学位置；尚无恢复位置时，按教案顺序定位首个未完成节点，不能沿用并行生成或失败段重试留下的文档预览游标。该初始化只投影画面，不提交教学动作、完成事件或证据；已有同课恢复位置不得被重置。
- 才新写（A2）：首页同课与课后「再听」共用一个独立 `replaySession` 生命周期。每次加载同一 `C + L` 后新建 replay `W`，播放范围严格取 `C` 中持久化的已讲范围（完成课即全课），并允许暂停 / 继续 /「结束重听」；加载失败留在发起入口的选择态，播放失败保留 replay `W` 的当前回放位置并可重试。自然结束或「结束重听」只销毁 replay `W`，按入口返回首页同课选择态或课后选择态。它不恢复旧 `W`、不调用 `finalizeSession`、不写 `C / L`、不新增 `EvidenceRecord`、不重判 `GoalState`
  - replay 在读取 C 范围后复用教案的 outline→生成 scene 绑定，把整段播放范围、导航与播放完成握手统一为生成场景节点 ID；已完成课含检查节点，未完成课不扩大持久化已讲范围。映射仅为读侧投影，不回写 C 或原教案。
  - 引擎启动确认后发生的语音或视觉动作失败仍须通知 replay 控制器，界面切换为可重试失败态，不得继续显示正在播放；暂停、继续、重试及其补偿事务保留各控制器方法的实例绑定。
  - 没有讲授动作的 replay 检查页沿用展示停留后自然推进，不把合成的空白停留动作发送给实时语音；有讲稿的节点仍等待真实语音结束。
- 改角色：插话先冻结 `resumeNode`，识别失败只提示重说；教师确认、回答后显式派发恢复命令。课中重听结束回到进入回放前的位置，不改变原教学序列
- 改角色（A2 闭环修复）：`lib/playback/engine.ts` 接收可取消的真实语音播放端口；课堂的每条 speech 交给 `LiveCourseRealtimeSession`，只在对应响应成功且音频实际结束后发出 speech end。暂停 / 插话取消未讲完语句并保留游标，恢复重新讲该语句；连接、生成、播放失败均显式报错，禁止回退到阅读计时器。普通非教学播放器保留原行为
- 才新写（A2 闭环修复）：`lib/livecourse/realtime/client/teacher-speech.ts` 定义课堂语音端口，复用现有 Realtime transport，不新增 ASR / TTS。显式讲稿、文字问题、自然语音共用单一会话；每次响应更新当前节点上下文。文字问题与麦克风共用插话事务，取消的讲稿不得冒充回答结束；等待作答时不要求存在正在播放的讲稿
- 改角色（J3.2 便捷提问）：`RealtimeTeacherControls.tsx` 增加快捷追问填入及选文引用预览 / 移除，仍显式调用原教师 `ask`，不新建问答或判分通道。`teacher-bridge.ts` 只投影正文选区（不读取输入控件 / contenteditable 草稿）；`InteractiveIframeHost.tsx` 校验消息来源、当前页面所有权、交互权限与 500 字上限，再写 `lib/livecourse/html/question-context.ts` 的临时引用。引用按 scene 隔离并随切页 / 回放 / 卸载清除；发送成功只消费本次引用，不清掉后来选中的内容；连接后重新核对节点与可提问状态。草稿不持久化，不写课堂动作或学习证据。
- 改角色（A2 闭环修复）：课堂壳在节点完成后自动推进，检查节点等待显式提交；不依赖旧圆桌的 `autoPlayLecture`。检查点经已注册的教师反馈端口先完成语音反馈，再完成提交迁移；重试复用已评分结果与 attempt identity，最后检查反馈前不得 finalization。答错补讲取本题解释与当前教案，不直接修改掌握投影。课中重听借用同一真实语音端口，结束显式恢复原位置，不提交讲授完成或检查证据
  - Volc 普通讲稿 / 回答同样必须有有效 PCM 且全部音源实际结束；取消音频事件不得充当回答完成，插话恢复等待冻结事务提交，失败保留原恢复点；普通连接跨节点使用最新 instructions。独立 replay 复用 receive-only 语音端口，不采集麦克风、不提供提问或课堂工具。
  - Volc 输入传输遵循官方双工协议：无麦克风、只读重听、静音与后台停流使用 `input_audio_mute.commit`，真实输入恢复时先发送 `input_audio_unmute.commit`，不以假音频保活。浏览器有界批量上传，服务端按 20ms / 640 字节转发 PCM；输入代次隔离静音和问答门禁前的迟到帧，网络积压显式失败。输入超时 `52000033` 与上游 5xx 错误关闭失效会话，普通讲稿 / 文字问题沿用有界重试重建连接，保留静音偏好与原节点；仍须真实输出音频结束才能推进，保活不产生回答或学习证据。
- 才新写（A2 闭环修复）：`lib/livecourse/session/teaching-flow.ts` 统一节点后继、检查反馈与提交去重。检查完成只表示已显式提交且有有效评分：客观评分 accepted 或模型评分 pending_review 均可证明完成本次检查；后者保留 model provenance 和 pending_review，不因此成为 accepted 掌握证据、不伪造人工审核。`GoalState` 仍只由原证据规则投影

完成：新课上课时只有教师音频与动作日志；插话后 `resumeNode` 回到原节点；失败不推进。讲授完成、未完成离开、finalization 与 replay 均走各自唯一的类型化幂等边界，`C` 进度及时持久化，且判分 / 重试 / 重听不重复证据。

### J3.2a 口头问答实现缝

- 才新写：教案 design 的可选 `oralQuestion { question, guidance }`；生成时绑定到中段 `SpeechAction.oralQuestion`，两条 HTML 生成路径共享该字段。正式检查不附加口头问答。
- 改角色：PlaybackEngine 在当前句真实音频结束后等待教师口头问答端口；完成前不处理下一动作，不提交节点完成。取消保持当前句游标，replay 不提供问答端口。
- 才新写：`realtime/client/oral-question.ts` 管理 asking / waiting / listening / responding / failed / ending，最多三个有效回答轮次；提示不计次，沉默不推进，失败重试同轮。问题、临时回答和轮次只在当前播放尝试内存在，不生成证据。
- 改角色：OpenAI 复用手动 VAD 和转写完成事件，口头答案使用独立的受控回应类型，不触发普通插话的自动恢复。Volc 复用原生双工回应及实际音频结束事件；等待前刷新问题上下文，非等待阶段关闭输入投递，结束恢复原讲课上下文。字幕仍只是展示，只有传输层的最终输入与真实音频边界驱动问答。
- 改角色：RealtimeTeacherControls 展示问题、阶段、文字回答、提示 / 继续和失败重试；语音及文字使用同一问答实例，防重复回答。课程控制器、判分和掌握投影不变。

## 2. 名册与画像 — 改角色

接口：默认名册只注册授课教师。生成画像可以没有，若有也不进入实时发言。

- 改角色：`lib/orchestration/registry/store.ts` 的 `DEFAULT_AGENTS` 只留 `role: 'teacher'`
- 改角色：`app/api/generate/agent-profiles/route.ts` 默认不生成 assistant / student
- 待撤：助教、显眼包、好奇宝宝、笔记员、思考者作为默认上台角色

完成：新生成课堂的可发言参与者只有教师。

## 3. 首页生成入口 — 改角色

接口：一个需求字符串 + 可选资料 + 一次提交。

- 改角色：`app/page.tsx` 去掉 `interactiveMode`、`vocationalTestMode` 主开关及对应 localStorage
- 沿用：单一 `requirement` 字段、资料上传、`/generation-preview` 流水线
- 改角色：目标和文件先停留在 UI 草稿 / 上传缓存；空目标禁用唯一主按钮「开始上课」。行内必填提示由目标框 touched / blur 或键盘提交尝试触发，不依赖 disabled click。文件选择与拖放共用逐文件状态，每个失败项可重试 / 移除，不清空目标或成功项
- 改角色：首次「开始上课」是课前草稿的唯一提交命令，提交中锁定防重复；提交后直接进入 `generation-preview`，课前确认在预览页内进行（见 §7 改角色 A3）。问题用逐题选项卡和「继续」；范围用推荐默认复选树和「按所选范围备课 / 使用推荐范围」
- 改角色：问题失败必须保留已答并提供重试或跳过。范围失败区分两类：首次知识树加载失败且没有推荐范围时，只能重试或明确「跳过范围确认，按需求与合理默认备课」；知识树已成功加载后的确认 / 提交失败，必须保留已选项和缓存推荐项，可重试或使用缓存推荐范围。全程只有一个「开始上课」，预览页内不再发第二次 start 命令
- 待撤产品面：首页「联网」开关。检索保留在设置，默认关；设置使用遮罩字段与显式保存，只写配置存储，不接 W / C / L

完成：首页主路径上看不到三种模式；提交只产生一堂可上的课；上传、追问与范围失败均可原地恢复，且全程只有一个「开始上课」。

## 4. 编辑器与改课 — 待撤产品面

接口：学习者路径上不存在编辑态。

- 待撤入口：`isLiveCourseEditorEnabled()` 已默认关；课堂壳与 Header 不再露出 Pro / 编辑切换
- 待撤入口：`lib/agent` 改元素 / 重生成场景的面板不挂到课堂页
- 沿用代码：`components/edit`、`packages/@livecourse/renderer` 的编辑能力先留着，S0–S2 不重写、不从主旅程引用
- 待撤入口：课堂主界面的 PPTX / MP4 导出。`render-service` 与 importer 代码可留

完成：按手册走完 J1–J5，碰不到编辑器、Agent 改课或导出审阅。

## 5. 教案 — 沿用，加法期改输入方向

接口：`LessonPlan`（目标、节点、检查点 + 每节点讲授设计）。上课读它，不在对话里另记进度。

- 沿用：`lib/livecourse/domain/lesson-plan.ts`
- 才新写（A1）：生成在大纲与内容之间写入 LessonPlan。教案设计 Agent 把每条大纲展开成节点讲授设计：`design.teachingPoints`（这个节点具体讲什么）、`design.explanationPlan`（怎么讲：引入、展开、小结）、`design.examples`、`design.anticipatedQuestions`（学生可能的问题与预设回应）、`design.misconceptions`（易错点）
- 才新写（A1）：教案随文档持久化（`AppDocumentOutline.lessonPlan`）；课堂运行时只读持久化 HTML 教案，缺 `presentation.mode = html` 时打开失败，不再反推
- 改角色（A1）：逐段内容生成以教案节点为输入，不再只看大纲条目
- 才新写（A5）：节点讲授设计增加声明式配图意图 `design.visualAids`（可选）：每项含全局唯一占位 `id`、给图片生成模型的 `prompt`、讲授用途 `purpose`、可选 `aspectRatio`。教案设计 Agent 只为确有需要静态示意图的讲授节点声明配图
- 禁止：平行再写一套课程大纲模型；教案 Agent 与学习者在界面对话（它是台后 worker）；教案侧直接调用图片生成 API（声明与执行分离，执行只走 §7 的既有媒体通道）

完成（A1）：每堂课先有含讲授设计、预设问答和 HTML 视觉方向的教案，再有课堂页；课堂只读这份教案。

## 6. 证据、掌握与多层记忆 — 沿用事实层，A6 才新写记忆层

接口：`EvidenceRecord` 是作答与检查的权威事实；`GoalState` 只由规则投影。记忆分为 `ClassroomWorkingMemory`（session）、`CourseLearningMemory`（learner + course）和 `LearnerMemory`（learner-only），使用不同 schema 与 repository，不做成一个自由文本 blob，也不新增学习者或人类教师工作台。

- 沿用：`lib/livecourse/domain/schemas.ts`、`evidence-reducer.ts`、`lib/quiz/grading.ts`。继续保持 `EvidenceRecord → GoalState` 的事实 / 投影分离，LLM 摘要不能替代证据或直接写掌握结论
- 沿用：`CourseStateSnapshot`、现有 evidence append stream 与 `@livecourse/storage` 的 `RuntimeStore`；默认 IndexedDB，经现有 HTTP adapter 可落 PostgreSQL。不得为记忆另建平行数据库或只支持一种后端的存储
- 才新写（A2）：学情摘要模块、`TeachingAdjustment`。路径必须在 `lib/livecourse/`
- 才新写（A6）：`lib/livecourse/memory/schemas.ts` 定义三套独立 schema：
  - `ClassroomWorkingMemory` 以 `classroomSessionId` 隔离，只含当前节点、最近插话 / 作答、`resumeNode`、临时调整和有上限的短摘要
  - `CourseLearningMemory` 以 `learnerId + courseId` 隔离，可引用当前课程 `LessonPlan` / 节点，并含进度、`EvidenceRecord`、`GoalState` 投影、误解与未解决问题；学习程度只能写在这里或本课课前判断中
  - `LearnerMemory` 以 `learnerId` 隔离，只允许白名单 learner-only 维度（语言、教学方法、节奏、互动 / 反馈方式、无障碍需要、稳定约束）。每个推断条目带 `sourceType`、不注入 prompt 的来源引用、`confidence`、`observedAt` / `updatedAt`；schema 禁止 `courseId`、课程名、知识点、题答、分数、掌握结论、课程摘要与原始对话
- 才新写（A6）：`lib/livecourse/memory/namespaces.ts` 是作用域构造的唯一入口；课程 repository 的读写 API 必须显式接收可信的 `learnerId + courseId`，缺 `courseId` 时 fail closed，不能退化成 learner-wide 搜索，也不能让模型拼 namespace 或 filter
- 才新写（A6）：`lib/livecourse/memory/repository.ts` 只在现有存储矩阵上提供类型化读写；同课程事实复用 `RuntimeStore` 分区与 append-only evidence，跨课程画像复用现有可配置存储能力，不增加账号 / 同步产品面。实现前须用现有 storage contract tests 固化 IndexedDB、HTTP、PostgreSQL 一致行为
- 才新写（A6）：`lib/livecourse/memory/policy.ts` 接收模型产生的 learner-profile candidate，但只有确定性白名单 policy 能写入。首页草稿与课前答案在生成开始时只写当前 `C`；本次明确表达立即在本课优先，但不立即写 `L`。只有 session `finalizeSession` 时，表达明确带有「长期 / 通常」语义，或跨多课独立证据达到 policy 门槛的 learner-only candidate，才可写 `L`。行为推断必须有来源与置信度，单次行为不能形成永久标签，冲突时不得静默覆盖
- 才新写（A6）：`lib/livecourse/memory/context.ts` 组装有大小上限的教师上下文，顺序固定为「本次明确表达 > 当前课堂工作记忆 > 同课程记忆 > 跨课程学习者记忆 > 默认值」。同课重开可读当前课程内容与证据；不同课新开只读 `LearnerMemory`，并在注入前再次通过白名单 schema
- 改角色（A6）：课前追问读取本次输入、同课程适用信息（仅重开同课）与 `LearnerMemory`，只问会改变本课设计且不能可靠回答的信息；学习程度始终按本课程 / 主题重新判断
- 禁止：本期引入 BKT / FSRS；禁止跨课程语义检索课程知识；禁止以 Mem0 式 metadata filter 代替物理 namespace / repository 边界；禁止把原始对话全文默认沉淀为画像

**事实与快照一致性**：evidence append stream 是 `EvidenceRecord` 的唯一权威事实源。`CourseStateSnapshot` 只保存恢复所需的物化副本 / 引用与明确 evidence tail revision，且必须由统一协调器从权威 stream 生成；调用方不得独立双写 evidence 数组与 append stream。恢复后 `GoalState` 可从权威证据重算，快照不是第二套可写事实。`lesson.complete_node` 是讲授完成的独立权威事件：去重后立即把 `completedNode / progress` 投影并持久化到当前 `C`，但绝不进入 evidence stream 或 `GoalState`。

**读取矩阵**：

| 场景 | 工作记忆 | 同课程记忆 | 跨课程学习者记忆 |
|---|---|---|---|
| 当前课堂继续 | 当前 session | 当前 `courseId` | 当前 `learnerId` |
| 重开同一课程 | 不读旧 session 临时项 | 同一 `learnerId + courseId` | 当前 `learnerId` |
| 新开不同课程 | 新建 | 不读其他 `courseId` | 当前 `learnerId` |

**交互事件 → W / C / L 矩阵**：

| 交互事件 | W | C | L |
|---|---|---|---|
| 新课首页草稿 / 上传 / 课前回答 | 不读写 | 生成前不写；尚无 `courseId` | 只读，供减少重复追问；当前明确偏好也不立即写 |
| 首页同课选择「继续」 | 仅未完成课新建 teaching W，不恢复旧 W | 读同一 `learnerId + courseId` 的未完成位置；不写 | 读当前 learner；不写 |
| 开始生成 | 不创建 | 创建 `courseId`，写需求、课前回答与最终范围；跳过范围时写合理默认 | 不写；课前表达只影响当前 C |
| 显式进入课堂 | 新建当前 session | 读当前课程 | 读白名单画像 |
| 插话 / 恢复点 | 写问题、`resumeNode`、当前状态 | 未解决问题可由协调器归档 | 原始对话禁止写入 |
| `lesson.complete_node` | 幂等标记节点完成 | 立即持久化 `completedNode / progress` | 不写；不产生 evidence、不表示掌握 |
| 提交检查 | 写提交中的短状态 | 按 idempotency key 唯一 append `EvidenceRecord` 并投影 `GoalState` | 不直接写 |
| 暂停 / 继续 / 课中重听 | 写暂停点、原位置与回放位置 | 只把可恢复点写快照 | 不写；不产生 evidence |
| 未完成「暂时离开课堂」 | `saveAndLeaveSession` 确认 C 写入后才销毁 | 先持久化恢复点；失败保持未完成并可重试 | 不写 |
| 完成课 `finalizeSession` | 归档全部成功后才销毁 | 幂等归档课堂进度、证据与课程内未解决问题 | 仅长期 / 通常显式偏好或多课证据达门槛的 learner-only candidate 通过 policy 后写 |
| 首页 / 课后启动 `replaySession` | 每次新建独立 replay W，不恢复旧 W；加载失败不离开各自选择态 | 只读持久化已讲范围，完成课为全课；不写 | 只读，不写；不产生 `EvidenceRecord`、不重判 `GoalState` |
| replay 暂停 / 继续 / 播放失败重试 | 写暂停点或保留当前回放位置 | 不写 | 不写；不产生 `EvidenceRecord`、不重判 `GoalState` |
| replay 自然结束 /「结束重听」 | 销毁 replay W；按入口回首页同课选择态或课后选择态 | 不写；不调用 `finalizeSession` | 不写；不重判 `GoalState` |
| finalization 后「离开」 | 不读写 | 不读写 | 不读写；只导航首页 |
| 设置保存 | 不读写 | 不读写 | 不读写；只改配置存储 |

所有表中事件都必须经类型化接口进入；模型可以提出 learner-only candidate，但不能选择 namespace、伪造 UI 成功事件或直接写 W / C / L。普通页面草稿、上传缓存、媒体加载和设置不是学习事件。

完成（S 期）：测验仍写入证据。完成（A2）：教师短上下文含「会 / 不会」，检查后能换节点；讲授完成立即持久化 C 进度且不伪造 evidence。完成（A6）：同课可恢复课程学习状态；不同课只能继承 learner-only 画像，`L` 只在 finalization 按长期表达 / 多课证据 policy 更新，并由负向测试证明没有其他课程内容泄漏。

## 7. 生成流水线 — 沿用

接口：大纲（场景骨架）→ 教案（节点讲授设计）→ 逐段内容 → 动作；失败只重做该段；备课不合成语音。

- 沿用：`packages/@livecourse/generation`、`lib/server/classroom-generation.ts`、`app/generation-preview/`、`lib/web-search` 供应商矩阵与 `/api/web-search`。设置里配置检索供应商、密钥与联网开关（默认关）；生成预览在开关打开且所选供应商已配置时检索。供应商含知乎全网搜索（`zhihu`，`GET https://developer.zhihu.com/api/v1/content/global_search`），可选 Filter / SearchDB 只写配置存储
- 改角色：预览为每个段维护 `waiting / generating / completed / failed`；只有失败段暴露「重试该段」。重试沿用同一 segment identity / idempotency key，成功段不重新排队、不被覆盖
- 改角色：正常生成或已完成的段可展开只读查看该段教案设计与已生成课堂材料（幻灯片缩略图 / 题面 / 互动页）；生成中的段显示当前子步骤。展开不写入 W / C / L，也不重做成功段
- 改角色：全部段 `completed` 后只把「进入课堂」置为可用，不自动导航。课堂加载失败保留预览与成功产物，可再次进入；页面恢复也不能把 `failed` 假装成 `completed`
- 改角色：首页最近课堂里 `generationComplete === false` 的课点开回到 `/generation-preview` 查看并继续备课，不进入 J4.4 同课选择态；返回首页保留可恢复的 generation session，不得丢掉已成功段
- 改角色（A1）：大纲不再独自决定「这堂课是什么」；LessonPlan 成为内容生成输入
- 才新写（A3）：`lib/livecourse/outline/` — 三个 Agent 组成大纲工作流：**课前追问 / 澄清**（只对会改变本课设计、且本次输入与适用记忆不能可靠回答的范围、本主题程度、目标、教学方法、深度、节奏或互动方式产出少量带选项问题）、**知识分解**（仅在范围不明确时列出主题知识点树供学习者勾选）、**审校**（大纲组装后检查范围覆盖与顺序，不合格修复一次）。问题均可跳过；编排沿用 `@langchain/langgraph`，不另选框架
- 才新写（A4）：`lib/livecourse/outline/subagent.ts` — worker Agent 的 subagent 运行器，沿用 `@earendil-works/pi-agent-core`（课堂 director 在用的 pi 运行时），worker 可派生并行 subagent。**知识分解**改两段：先粗分枝干，再每个枝干派一个 subagent 并行细分解后合并（单次调用列不全「高数」这类大主题）；**教案设计**按节点派并行 subagent，每节点一份详细设计。约束：subagent 同为台后 worker，不在界面出现；并发有上限；任一 subagent 失败降级回单调用路径
- 才新写（A5）：`lib/livecourse/lesson/visual-aids.ts` —— 逐段内容生成前把教案各节点 `design.visualAids` 合并进对应 outline 的 `mediaGenerations`（幂等，不覆盖既有 elementId）。执行仍走 media-orchestrator / `/api/generate/image` 与 `lib/media` 适配器矩阵，不新增 provider 路径；subagent 保持无工具——配图是声明式意图，不是工具调用
- 改角色（A3）：`app/generation-preview/page.tsx` 在开始生成大纲之前按需内嵌课前问题卡片与范围勾选（首页只负责提交草稿）；`app/api/generate/scene-outlines-stream` 接受课前答案与勾选范围作为大纲生成输入。知识树首次加载失败时尚无推荐缓存，只能重试或明确按需求与合理默认跳过范围确认；成功加载后必须缓存已选与推荐项，使确认 / 提交失败可重试或使用缓存推荐范围。主题具体只允许省略范围分解，不代表程度 / 方法信息不足时必然无追问
- 改角色（A6）：上述输入再接收经过 §6 policy 过滤的 `LearnerMemory`；同课重开可接收同课程摘要，不同课不得接收其他课程摘要
- 禁止：课前追问不出现在课堂内；不新增首页产品开关；不平行再写一套大纲模型（A1 的 LessonPlan 仍在大纲与内容之间）；不做必填长问卷或重复询问已可靠知道的信息
- **台前单 Agent**（A1/A3 共同约束）：澄清、分解、审校、教案设计全是台后 worker。学习者界面只出现一位 Agent 老师（首页澄清卡片与课堂授课同一人设），不展示工作流状态、不区分 Agent 身份

完成（S 期）：单调用大纲生成可被播放引擎上课。完成（A1）：大纲之后先写教案，内容生成读教案节点。完成（A3）：「我想学高数」先出范围可选项，勾选后大纲只覆盖所选知识点。

- 沿用：PBL v2 作为项目场景类型，不升成首页模式

完成：生成结果可被播放引擎上课，且不在备课时配音。

### A5.1 模型原生 HTML 课堂

- 才新写：`lib/livecourse/lesson/html-presentation.ts` 负责主 Agent 的课程级视觉方向与自由 HTML 页面 prompt。教案 schema 增加可选 `presentation: { mode: 'html', visualStyle: string }`；视觉方向以自由文本描述配色、字体、构图、图形语言和动效，不引入另一套模板枚举。先定风格，再让节点 worker 读同一方向。风格失败显式报错；节点设计失败仍可使用真实大纲骨架。
- 改角色：`app/api/generate/lesson-plan/`、`app/generation-preview/`、`lib/hooks/use-scene-generator.ts`、`app/api/generate/scene-content/`、`lib/server/classroom-generation.ts` 只生成 HTML 课；视觉方向失败则整课失败，禁止无 presentation 继续。打开课堂时 `assertHtmlClassroom`：无 `presentation.mode = html`、或含 slide / widget / PBL 场景的文档显式失败，不回退播放。
- 改角色：`lib/generation/scene-generator.ts`、`scene-builder.ts` 沿用内容与动作两阶段。非检查页用 interactive HTML 存储/动作通道，不要求 widget 分类；检查仍为 quiz，必须带 HTML 字段，结构化题目保留为判分事实。两种场景构造路径必须保存 HTML，不把检查变成无需作答的普通互动。`generateSceneContent` 没有 HTML presentation 时失败。
- 改角色：`packages/@livecourse/dsl/src/stage.ts`、`lib/types/generation.ts` 增加可选 quiz HTML；存储和媒体处理沿用现有文档/资源通道。不做旧格式迁移。
- 改角色：场景渲染、测验视图、生成预览、场景缩略图显示真实 HTML。自由布局与页内 JavaScript 在不带 `allow-same-origin` 的 iframe 沙箱运行；保留运行错误反馈。测验桥只传递经校验的当前题目答案/展示状态，显式提交及重试沿用原判分与幂等逻辑，不接受页内宣称的分数或完成事件；只读预览与 replay 不写 evidence、C 或 L。
- 沿用：既有 `postProcessInteractiveHtml`、iframe host、媒体占位替换、节点控制器与语音完成边界；HTML 页不得越权访问宿主页、配置密钥、课程存储或注册新发言者。
- 才新写：`lib/livecourse/html/teacher-bridge.ts` 给新讲授页注入通用高亮、标注与显露处理；只接收父窗口的既有类型化消息，不要求模型每页重复实现通信代码，也不限制页面构图。`quiz-bridge.ts` 只传递草稿与宿主展示状态，不能提交或判分。
- 改角色（HTML 讲授同步）：页面提供真实稳定的教学区域 id；动作生成沿用元素清单，逐段先显露 / 高亮再讲解，拒绝纯讲稿、虚构目标和讲完才执行的动作。高亮持续到下一重点。课堂渲染时升级已注入的教师桥，不改写持久化 HTML；宿主等待桥的 DOM 就绪与动作执行确认，失败交还现有播放游标重试，暂停 / 插话 / 切页取消尚未投递的动作。replay 投递讲授视觉动作但不写证据或课程进度。

完成：每页都有模型 HTML；逐页生成前先确定主 Agent 的方向，所有页复用该方向，方向随课持久化；页面生成失败不回退成固定模板；缩略图与预览不再使用虚构占位画面；无 HTML 方向的课打开失败；检查恢复、回放与单段重试语义不变。

## 8. 编排 — 改用途，不换框架

接口：课中环节是讲授 / 检查 / 材料场景。PBL 与扮演只是一种材料 / 场景类型，角色内容由同一教师通过舞台与类型化动作呈现，不是第二个情境 Agent 或多名同学抢话筒。

- 沿用库：`@langchain/langgraph`
- 改角色：`lib/orchestration/director-graph.ts` 从圆桌轮次改为环节切换（A 期）。S 期先把默认名册与发言权收掉，不换编排框架
- 禁止：PBL / 扮演场景注册第二位可发言 Agent。若未来需要第二发言者，必须先在 `01-user-journeys.md` 与 `02-product-manual.md` 定义其输入、反馈、失败恢复与状态迁移

完成（S 期）：导演不再派同学或情境 Agent 发言。完成（A 期）：环节切换有明确节点，而不是讨论 END；所有场景只有同一教师开口。

## 9. 评测与杂项入口 — 待撤产品面

- `app/eval/whiteboard`：移出主应用路由，或仅开发环境可见
- 十国语言包、ComfyUI 说明、访问码：不进手册；S 期不强制删除实现

## 参考开源（禁止平行造轮子）

| 缝 | 沿用 | 才新写的条件 |
|---|---|---|
| 材料与舞台 | 本仓库 OpenMAIC 迁入层、`packages/@livecourse/*` | 现有 DSL 表达不了新场景类型 |
| 课中编排 | `@langchain/langgraph` | 不得另选编排框架 |
| 生成侧 subagent 运行时 | `@earendil-works/pi-agent-core`（`lib/chat/pi`、`lib/agent/runtime` 在用） | 不得另选 agent 循环框架 |
| 全双工 | OpenAI Realtime + Agents SDK、`lib/livecourse/realtime` | 不得再接一套课中 ASR/TTS 主路径 |
| 形象 | `@pixiv/three-vrm` / Airi | 不得换形象栈 |
| 存储 | IndexedDB 默认、HTTP adapter、可选 PostgreSQL、`@livecourse/storage` | 不得为课程或记忆再写一套数据库 |
| 记忆作用域 | [LangGraph JS memory](https://docs.langchain.com/oss/javascript/langgraph/add-memory) / [persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)：thread / checkpointer 与 Store namespace、profile / collection 的职责划分；项目已有 `@langchain/langgraph` | 沿用分层与 namespace 模式；不得新增另一套编排框架。是否接其 Store / checkpointer 必须先证明现有 `RuntimeStore` 缝不够 |
| 作用域 metadata | [Mem0 memory operations](https://docs.mem0.ai/open-source/features/memory-operations) / [metadata filtering](https://docs.mem0.ai/open-source/features/metadata-filtering)：`user_id` / `run_id` 与来源 metadata | 只借鉴标识与 provenance；filter 不是安全边界，不引入 Mem0 依赖或第二事实源 |
| 上下文装配 | [Letta memory](https://docs.letta.com/guides/agents/memory) / [MemGPT architecture](https://docs.letta.com/guides/agents/architectures/memgpt)：bounded core 与 archival 分离 | 只借鉴有上限的 core packet；不引入 Letta runtime，也不允许 Agent 自治改写全部画像 |
| 教育证据模型 | [Moodle Competency API](https://moodledev.io/docs/5.0/apis/subsystems/competency) / [Moodle core classes](https://github.com/moodle/moodle/tree/master/admin/tool/lp/classes)：evidence 与 user competency / proficiency 分离 | 映射现有 `EvidenceRecord → GoalState`；不引入 Moodle 管理 UI、人工审批或 competency framework |

需要新库时，在本节追加一行「现有缝不够」的理由，再改代码。A6 首选复用上表模式和既有依赖 / 存储适配器；本期禁止引入 Mem0、Letta、Moodle 或完整的新 memory runtime。

## 完成标准

每个将要改的文件能对上本节一条缝，并带「沿用 / 改角色 / 待撤 / 才新写」；每个台前事件还必须对上 `01` 六列契约和 §6 的 W / C / L 矩阵。S0–S1 只动改角色与待撤入口，不新增领域文件。

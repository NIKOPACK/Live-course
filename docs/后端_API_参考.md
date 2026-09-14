# LiveCourse 后端 API 参考

> 适用版本：`0.3.1`（以 `demo-flow` 分支为准）
>
> 更新时间：2026-08-16
> 面向对象：部署运维人员、前端维护者，以及需要在同一受信任环境中集成 LiveCourse 的开发者。

## 1. 定位与边界

LiveCourse 的后端是同域 BFF（Backend for Frontend），服务于 Web 应用自身；目前**不是版本化的公共 SaaS API**。接口没有 `/v1` 前缀、没有 OpenAPI 发布物，且部分接口允许未托管供应商从浏览器传入凭证。因此：

- 生产环境应仅将应用暴露给受信任用户，或设置 `ACCESS_CODE`；不要直接把这些接口当作多租户公网 API。
- 以服务端环境变量或 `server-providers.yml` 配置供应商为首选。已配置为托管（managed）的供应商会忽略客户端传来的 key 与 base URL。
- `Stage`、`Scene`、`SceneOutline`、`PBLProjectV2` 等大对象由前端持有并随请求回传；它们的唯一权威定义是 TypeScript 源码，而非本文件的示例。
- 除明确标记为文件/媒体/SSE 的接口外，均使用 JSON。

默认基地址：`http://localhost:3000`。以下路径均相对于基地址。

## 2. 快速开始

启动应用并检查运行状态：

```bash
pnpm dev
curl http://localhost:3000/api/health
```

成功响应示例：

```json
{
  "success": true,
  "status": "ok",
  "version": "0.3.1",
  "capabilities": {
    "webSearch": false,
    "imageGeneration": false,
    "videoGeneration": false,
    "tts": false
  }
}
```

创建一节服务端托管的课堂并轮询完成状态：

```bash
curl -X POST http://localhost:3000/api/generate-classroom \
  -H 'Content-Type: application/json' \
  -d '{"requirement":"为初学者讲解牛顿第二定律，包含 3 个场景"}'

# 取得响应中的 jobId 后轮询
curl http://localhost:3000/api/generate-classroom/<jobId>
```

该工作流只能使用服务端配置的模型；请求携带 `x-api-key`、`x-base-url`、`x-model` 或供应商相关请求头会被拒绝。

## 3. 通用约定

### 3.1 鉴权

未设置 `ACCESS_CODE` 时，应用不启用访问码校验。设置后：

1. `POST /api/access-code/verify`，正文为 `{"code":"<访问码>"}`。
2. 成功后服务端写入 `HttpOnly` Cookie：`livecourse_access`，有效期 7 天。
3. 除 `/api/access-code/*` 与 `/api/health` 外，所有 `/api/*` 路由均要求该 Cookie；否则返回 `401`。

Cookie 认证适用于浏览器同域调用。当前没有 Bearer Token、用户身份或细粒度授权模型。

### 3.2 标准 JSON 包装

采用 `apiSuccess` / `apiError` 的接口成功时都含 `success: true`：

```json
{ "success": true, "...业务字段": "..." }
```

标准失败格式：

```json
{
  "success": false,
  "errorCode": "INVALID_REQUEST",
  "error": "可读错误信息",
  "details": "可选上游细节"
}
```

常见 `errorCode`：`MISSING_REQUIRED_FIELD`、`MISSING_API_KEY`、`INVALID_CREDENTIALS`、`INVALID_REQUEST`、`INVALID_URL`、`PROVIDER_DISABLED`、`RATE_LIMITED`、`UPSTREAM_ERROR`、`GENERATION_FAILED`、`PARSE_FAILED`、`INTERNAL_ERROR`。文件和流式媒体代理的少数错误直接返回 `{ "error": "..." }`。

### 3.3 LLM 请求头

下列生成/对话接口通过同一模型解析器选择模型：

| 请求头 | 说明 |
| --- | --- |
| `x-model` | 模型标识，例如 `openai/gpt-4o-mini`。无服务端路由时会回退至 `DEFAULT_MODEL`。 |
| `x-api-key` | 未托管 LLM 供应商的密钥。 |
| `x-base-url` | 未托管 LLM 供应商的 OpenAI 兼容基地址。生产环境会执行 SSRF 校验。 |
| `x-provider-type` | 供应商类型；若与注册供应商类型不一致则拒绝。 |
| `x-user-locale` | 部分生成/PBL 请求使用的语言提示。 |

正文可选 `thinkingConfig`（旧字段 `thinking` 也兼容）。`MODEL_ROUTES` 中配置的阶段模型优先级高于浏览器请求头，且会使用服务端凭证。

### 3.4 SSE

下列接口返回 `Content-Type: text/event-stream`：场景大纲、聊天、PBL v2，以及火山实时语音事件。每个 SSE 帧为 `data: <JSON>\n\n`；心跳可能是 `:heartbeat` 注释。客户端应使用 `fetch` + `ReadableStream` 解析（POST SSE 不能直接用原生 `EventSource`）。

## 4. API 总览

### 4.1 运行、访问与运维

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 存活状态、版本与已启用能力。 |
| GET | `/api/access-code/status` | 访问码是否启用、当前 Cookie 是否已认证。 |
| POST | `/api/access-code/verify` | 校验访问码并设置认证 Cookie。 |
| GET | `/api/server-providers` | 当前服务端供应商能力与并发配置。敏感部署中不要对匿名用户开放。 |
| GET | `/api/usage?months=YYYY-MM,...` | 聚合 `data/usage/*.jsonl` 使用量。 |
| GET/POST/PUT/PATCH/DELETE | `/api/persistence/<path>` | PostgreSQL 持久化服务的透传接口。需要 `DATABASE_URL` 和 `PERSISTENCE_DEV_TOKEN`。 |

### 4.2 课堂创建与资产

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/classroom` | 保存 `stage` 与 `scenes`，创建可加载课堂。 |
| GET | `/api/classroom?id=<id>` | 读取已保存课堂。 |
| POST | `/api/generate-classroom` | 后台生成整节课堂任务。 |
| GET | `/api/generate-classroom/<jobId>` | 查询课堂生成进度和结果。 |
| GET | `/api/classroom-media/<classroomId>/(media|audio)/<path>` | 读取课堂生成的本地媒体文件。 |

### 4.3 内容、聊天与作业生成

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/generate/scene-outlines-stream` | SSE：从需求生成课程场景大纲。 |
| POST | `/api/generate/scene-content` | 根据单个大纲生成场景内容（两段式流程第 1 步）。 |
| POST | `/api/generate/scene-actions` | 根据内容生成动作并组装场景（第 2 步）。 |
| POST | `/api/generate/agent-profiles` | 生成教师、助教、学生代理档案。 |
| POST | `/api/chat` | SSE：默认多代理课堂聊天。 |
| POST | `/api/chat/pi` | SSE：实验性 Pi Director 聊天运行时。 |
| POST | `/api/agent/edit` | SSE：编辑代理对当前场景进行受限编辑。 |
| POST | `/api/quiz-grade` | 使用 LLM 评分一道简答题。 |

### 4.4 文档、媒体、语音与检索

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/extract-document` | 提取文档、图片、音视频课程材料。 |
| POST | `/api/parse-pdf` | PDF 专用提取兼容接口。 |
| POST | `/api/generate/image` | 生成一张图片。 |
| POST | `/api/generate/video` | 生成一个视频。 |
| POST | `/api/generate/tts` | 将文本合成为 base64 音频。 |
| POST | `/api/generate/voice` | 注册/恢复可复用的自动音色。 |
| POST | `/api/transcription` | 音频转写。 |
| POST | `/api/proxy-media` | 受 SSRF 限制的远端媒体读取代理。 |
| GET | `/api/comfyui-workflows` | 列出可用 ComfyUI 工作流。 |
| POST | `/api/web-search` | 使用配置的搜索供应商检索并格式化上下文。 |
| POST | `/api/azure-voices` | 查询 Azure Speech 可用音色。 |

### 4.5 供应商连通性与视频导出

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/verify-model` | 测试 LLM 模型连通性。 |
| POST | `/api/provider/probe-models` | 调用兼容 `/models` 端点发现聊天模型。 |
| POST | `/api/verify-image-provider` | 验证图片供应商。 |
| POST | `/api/verify-video-provider` | 验证视频供应商。 |
| POST | `/api/verify-pdf-provider` | 验证 PDF/文档供应商。 |
| GET | `/api/export-video/capability` | 检查渲染服务是否可用。 |
| POST | `/api/export-video/render` | 上传导出 ZIP，异步创建 MP4 渲染任务。 |
| GET/DELETE | `/api/export-video/render/<jobId>` | 查询或取消渲染任务。 |
| GET | `/api/export-video/render/<jobId>/download` | 下载或 302 跳转到渲染成品。 |

### 4.6 LiveCourse 实时课堂与 PBL v2

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/livecourse/avatar/model` | 代理默认 VRM 教师模型。 |
| POST | `/api/livecourse/realtime/client-secret` | 创建浏览器实时语音会话的短期凭证。 |
| POST | `/api/livecourse/realtime/tools` | 映射实时模型工具调用为教学命令。 |
| POST/GET | `/api/livecourse/realtime/volc` | 创建/控制火山双工实时语音会话；GET 为事件流。 |
| POST | `/api/pbl/v2/open-task` | SSE：打开 PBL 任务时由 Instructor 主动开场。 |
| POST | `/api/pbl/v2/instructor` | SSE：PBL Instructor 处理学习者消息。 |
| POST | `/api/pbl/v2/simulator` | SSE：情境项目中的角色扮演 Simulator。 |
| POST | `/api/pbl/v2/evaluate` | SSE：任务、里程碑或最终评估。 |
| POST | `/api/pbl/v2/task/update` | 不经 LLM 地更新 PBL 项目进度。 |

## 5. 关键接口详解

### 5.1 访问码

`POST /api/access-code/verify`

```json
{ "code": "your-access-code" }
```

成功：`{ "success": true, "valid": true }`，并通过 `Set-Cookie` 设置认证 Cookie。访问码未启用时同样返回成功，但不写 Cookie。错误：无效 JSON 为 `400`，缺失或错误访问码为 `401`。

`GET /api/access-code/status` 返回：

```json
{ "success": true, "enabled": true, "authenticated": false }
```

### 5.2 整节课堂生成与读取

`POST /api/generate-classroom` 仅接受严格 JSON：

```json
{
  "requirement": "讲解牛顿第二定律，面向初中生，含交互练习",
  "pdfContent": { "text": "可选的已提取文本", "images": ["data:image/png;base64,..."] }
}
```

返回 `202`：

```json
{
  "success": true,
  "jobId": "AbCdEf1234",
  "status": "queued",
  "step": "queued",
  "message": "...",
  "pollUrl": "http://localhost:3000/api/generate-classroom/AbCdEf1234",
  "pollIntervalMs": 5000
}
```

轮询 `GET /api/generate-classroom/<jobId>`，直到 `done: true`。成功任务在 `result` 返回完整生成结果；失败任务在 `error` 返回信息。无效或不存在任务 ID 分别为 `400`、`404`。

`POST /api/classroom` 的正文为 `{ "stage": Stage, "scenes": Scene[] }`，成功创建返回 `201`：`{ "success": true, "id": "...", "url": "..." }`。`GET /api/classroom?id=<id>` 返回 `{ "success": true, "classroom": { ... } }`。

权威类型：[stage.ts](../lib/types/stage.ts)、[generation.ts](../lib/types/generation.ts)。

### 5.3 两段式场景生成

生成单个场景时必须按顺序调用：

```text
scene-outlines-stream → scene-content → scene-actions
```

`POST /api/generate/scene-outlines-stream` 请求正文：

```json
{
  "requirements": {
    "requirement": "讲解二次函数图像",
    "interactiveMode": true,
    "userNickname": "小林",
    "userBio": "高中一年级"
  },
  "pdfText": "可选的材料文本",
  "pdfImages": [],
  "imageMapping": {},
  "researchContext": "可选检索上下文",
  "agents": []
}
```

SSE 的 JSON 事件：

| `type` | 数据 |
| --- | --- |
| `languageDirective` | `{ data: string }` |
| `courseTitle` | `{ data: string }` |
| `outline` | `{ data: SceneOutline, index: number }` |
| `retry` | `{ attempt: number, maxAttempts: number }` |
| `done` | `{ outlines: SceneOutline[], languageDirective: string, courseTitle?, taskEngineMode }` |
| `error` | `{ error: string }` |

`POST /api/generate/scene-content` 的必填字段为 `outline`、非空 `allOutlines`、`stageId`。可选：`pdfImages`、`imageMapping`、`agents`、`languageDirective`、`requirements`。成功返回 `{ success, content, effectiveOutline }`。

`POST /api/generate/scene-actions` 的必填字段为 `outline`、非空 `allOutlines`、`content`、`stageId`；可选：`agents`、`previousSpeeches`、`userProfile`、`languageDirective`。成功返回 `{ success, scene, previousSpeeches }`。将本次的 `previousSpeeches` 传给下一场景可保持叙事连贯。

权威类型：[generation.ts](../lib/types/generation.ts)、[stage.ts](../lib/types/stage.ts)、[action.ts](../lib/types/action.ts)。

### 5.4 文档与媒体材料

`POST /api/extract-document` 使用 `multipart/form-data`：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `file`（兼容 `pdf`） | 是 | 课程材料。支持的具体 MIME 由提取器注册表决定。 |
| `providerId` | 否 | 首选文档/媒体提取器。 |
| `apiKey`、`baseUrl` | 否 | 未托管 PDF 供应商配置。 |
| `accessKeyId`、`accessKeySecret` | 否 | AliDocMind 未托管凭证。 |

返回 `{ "success": true, "data": ParsedPdfContent }`。单文件上限由 `MAX_EXTRACT_DOCUMENT_FILE_SIZE_BYTES` 控制；超过上限返回 `413`。`POST /api/parse-pdf` 是仅接收 `pdf` 文件的兼容版本，额外字段为 `providerId`、`apiKey`、`baseUrl`，返回结构相同。

`ParsedPdfContent` 含 `text`、`images`、可选 `tables` / `formulas` / `layout` 和 `metadata`。完整字段见 [pdf.ts](../lib/types/pdf.ts)。

`POST /api/generate/image` 正文：

```json
{ "prompt": "黑板上的二次函数图像", "aspectRatio": "16:9", "style": "educational illustration" }
```

请求头：`x-image-provider`（默认 `seedream`）、可选 `x-image-model`、`x-api-key`、`x-base-url`。成功返回 `{ success, result }`，其中 `result` 为 `url?`、`base64?`、`width`、`height`。

`POST /api/generate/video` 正文：`{ "prompt": "...", "duration": 5, "aspectRatio": "16:9", "resolution": "720p" }`。请求头使用 `x-video-provider`、`x-video-model`、`x-api-key`、`x-base-url`，返回 `{ success, result }`，结果含 `url`、尺寸、时长和可选 `poster`。供应商 ID 与完整类型见 [media/types.ts](../lib/media/types.ts)。

`POST /api/proxy-media` 正文为 `{ "url": "https://..." }`，返回远端内容的二进制流。仅限 HTTP(S)、禁止重定向和内网/元数据地址，且响应体最多 50 MB；这是浏览器 CORS 兼容工具，不应作为通用下载代理。

### 5.5 语音

`POST /api/generate/tts`：

```json
{
  "text": "牛顿第二定律说明力会改变物体的运动状态。",
  "audioId": "speech-001",
  "ttsProviderId": "openai",
  "ttsVoice": "alloy",
  "ttsModelId": "可选模型",
  "ttsSpeed": 1,
  "ttsProviderOptions": {}
}
```

未托管供应商可在正文传 `ttsApiKey`、`ttsBaseUrl`。成功返回 `{ success, audioId, base64, format }`；浏览器 TTS 不能调用本路由；供应商被服务端禁用时为 `403`，限流为 `429`。

`POST /api/generate/voice` 用于已支持注册的 TTS 供应商：`providerId`、`voiceId`，以及 `descriptor` 或 `referenceAudioBase64` 二选一必填；可选 `language`、`mimeType`、`ttsApiKey`、`ttsBaseUrl`、`ttsModelId`。成功返回 `{ success, voiceId, registered, referenceAudioBase64?, mimeType? }`。

`POST /api/transcription` 使用 `multipart/form-data`，字段为 `audio`（必填）、`providerId`（必填）及可选 `apiKey`、`baseUrl`；成功返回 `{ success, text }`。

### 5.6 聊天、编辑与测验

`POST /api/chat` 和 `POST /api/chat/pi` 都接收 `StatelessChatRequest`，并以 SSE 返回 `StatelessEvent`。请求至少应包含：

```json
{
  "messages": [],
  "storeState": { "stage": null, "scenes": [], "currentSceneId": null, "mode": "playback", "whiteboardOpen": false },
  "config": { "agentIds": ["teacher"] },
  "apiKey": "仅未托管模型需要",
  "model": "openai/gpt-4o-mini"
}
```

完整请求、事件类型和可选代理配置见 [chat.ts](../lib/types/chat.ts)。调用方必须在每一轮回传前端维护的状态；后端不保存聊天会话。`/api/chat/pi` 需启用实验性 Pi 运行时，且对 `piSessionBoundary` 有额外前端流程约束。

`POST /api/agent/edit` 以 SSE 返回受限编辑代理的结果，必填正文为 `{ "message": string, "sceneContext": SceneContextMap }`；`sceneContext` 导出自其路由文件。缺失当前场景上下文返回 `404`。

`POST /api/quiz-grade`：

```json
{ "question": "写出牛顿第二定律", "userAnswer": "F=ma", "points": 5, "language": "zh-CN" }
```

`question`、`userAnswer`、正整数 `points` 必填；`commentPrompt` 与 `language` 可选。成功返回 `{ success, score, comment }`，`score` 保证位于 `0..points`。

### 5.7 PBL v2

PBL v2 是**无状态回传模型**：客户端每次都提交完整 `PBLProjectV2`，从返回 SSE `project_patch` 中更新本地项目。不要把这些接口作为普通 CRUD；请复用现有客户端 SSE 解析器与类型。

| 路径 | 关键正文 | 返回 |
| --- | --- | --- |
| `/api/pbl/v2/open-task` | `project`、`phase: "greeting" | "setup"`、可选 `priorQuizResults` | Instructor SSE |
| `/api/pbl/v2/instructor` | `project`、非空 `userMessage`、可选 `phase` | Instructor SSE |
| `/api/pbl/v2/simulator` | `project`、可选 `userMessage`、`phase?: "greeting" | "instructing"` | Simulator SSE；仅情境项目可用 |
| `/api/pbl/v2/evaluate` | `project`、`kind: "task" | "milestone" | "final"`；task 需要 `milestoneId` + `microtaskId`，milestone 需要 `milestoneId` | 评估 SSE |
| `/api/pbl/v2/task/update` | `project`、`action`，`start` 还需 `microtaskId` | 标准 JSON，含更新后的 `project` |

`task/update.action` 允许：`start`、`continue_handover`、`complete_pending_task`、`enter_scenario`、`complete_act`；后两项只允许情境项目。SSE 事件定义在 [pbl/v2/api/sse.ts](../lib/pbl/v2/api/sse.ts)，项目结构在 [pbl/v2/types.ts](../lib/pbl/v2/types.ts)。

### 5.8 实时课堂

`POST /api/livecourse/realtime/client-secret`：需要 `x-learner-key` 请求头及正文 `{ "courseId": "...", "lessonId": "..." }`，返回短期实时客户端凭证。`POST /api/livecourse/realtime/tools` 同样需要该请求头，正文为 `RealtimeToolRequest`，返回可派发的教学命令。

实时工具允许 `goto_node`、`highlight`、`pointer`、`board_text`、`board_clear`、`expression`、`look_at`、`show_source`。请求/响应精确结构见 [realtime/contracts.ts](../lib/livecourse/realtime/contracts.ts)。

`POST /api/livecourse/realtime/volc` 使用判别字段 `action`：

| `action` | 额外字段 | 结果 |
| --- | --- | --- |
| `create` | `voice?` | `{ sessionId }` |
| `start`、`stop`、`commit`、`cancel`、`close` | `sessionId` | `{ success: true }` |
| `append` | `sessionId`、音频数据 | `{ success: true }` |

`GET /api/livecourse/realtime/volc?sessionId=<id>` 返回该会话的 SSE 事件流。完整动作 schema 在 [realtime/volc/protocol.ts](../lib/livecourse/realtime/volc/protocol.ts)。

### 5.9 供应商、检索、导出和持久化

| 接口 | 请求重点 | 成功响应重点 |
| --- | --- | --- |
| `POST /api/verify-model` | `{ model, apiKey?, baseUrl?, providerType? }`，`model` 必填 | `message`、上游 `response` |
| `POST /api/provider/probe-models` | `{ baseUrl, apiKey?, modelsUrl? }`，`baseUrl` 必填 | `models: [{ id, ownedBy? }]`、`total`、`filtered` |
| `POST /api/verify-image-provider` | 供应商由 `x-image-provider` 等头指定 | `message` |
| `POST /api/verify-video-provider` | 供应商由 `x-video-provider` 等头指定 | `message` |
| `POST /api/verify-pdf-provider` | `{ providerId, apiKey?, baseUrl?, accessKeyId?, accessKeySecret? }` | `message`、部分场景含 `status` |
| `POST /api/web-search` | `{ query, pdfText?, providerId?, apiKey?, baseUrl?, zhihuFilter?, zhihuSearchDB? }` | `answer`、`sources`、`context`、`query`、`responseTime` |
| `POST /api/azure-voices` | `{ apiKey, baseUrl }` | `voices` |
| `GET /api/usage` | 可选 `months=YYYY-MM,...` | totals、按模型/日期/类型聚合桶 |

视频导出：`GET /api/export-video/capability` 返回是否能调用渲染服务；`POST /api/export-video/render` 接收 `multipart/form-data` 的导出 ZIP，最大 300 MiB，返回 `202 { success, jobId, pollIntervalMs: 3000 }`。随后轮询 `GET /api/export-video/render/<jobId>`，可使用 `DELETE` 取消，完成后 GET `/download` 下载 MP4。未配置 `RENDER_SERVICE_URL` 时相关接口返回 `501 PROVIDER_DISABLED`。

`/api/persistence/*` 由 `@livecourse/storage` 的 HTTP handler 提供，包含自己的路径和鉴权语义，不应根据本文件猜测。启用条件是 `DATABASE_URL` 与 `PERSISTENCE_DEV_TOKEN`，参考 [route-handler.ts](../lib/persistence/route-handler.ts) 和 [server-auth.ts](../lib/persistence/server-auth.ts)。

## 6. 部署检查清单

1. 复制 `.env.example` 至 `.env.local`，至少设置一个 LLM 供应商或 `DEFAULT_MODEL`；整节课堂生成只接受服务端模型配置。
2. 公网部署设置 `ACCESS_CODE`，并在反向代理层增加真实的用户认证/访问控制。
3. 若启用持久化，设置 `DATABASE_URL`、`PERSISTENCE_DEV_TOKEN`；若启用视频导出，设置 `RENDER_SERVICE_URL`。
4. 不要把浏览器传入的供应商密钥写入日志、数据库或分析系统；优先让服务端托管密钥。
5. 对外集成前固定部署提交并为目标接口补充版本化网关或 OpenAPI contract；当前内部类型可以随前端演进。

## 7. 代码索引

| 主题 | 权威位置 |
| --- | --- |
| 路由实现 | [`app/api/`](../app/api/) |
| 标准响应与错误码 | [api-response.ts](../lib/server/api-response.ts) |
| 模型/凭证解析 | [resolve-model.ts](../lib/server/resolve-model.ts) |
| 访问码中间件 | [middleware.ts](../middleware.ts) |
| 场景与生成模型 | [generation.ts](../lib/types/generation.ts) |
| 聊天请求/事件 | [chat.ts](../lib/types/chat.ts) |
| PBL 事件与模型 | [pbl/v2/api/sse.ts](../lib/pbl/v2/api/sse.ts)、[pbl/v2/types.ts](../lib/pbl/v2/types.ts) |
| 实时课堂契约 | [realtime/contracts.ts](../lib/livecourse/realtime/contracts.ts) |

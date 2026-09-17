/**
 * 教案设计 Agent（docs/spec/04-detailed-design.md §5、§7，才新写 A1）。
 *
 * 台后 worker：不与学习者对话，界面不出现它的身份。大纲之后、逐段内容
 * 生成之前，把每条大纲展开成节点讲授设计（teachingPoints 讲什么 /
 * explanationPlan 怎么讲 / examples / anticipatedQuestions 预设学生提问
 * 与回应 / misconceptions 易错点），组装成 LessonPlan 随文档持久化。
 *
 * LLM 只负责每个节点的 design 内容；goals/nodes 的骨架由代码侧按
 * deriveLessonPlanFromStage 的 ID 约定组装（反推只服务旧课导入）。
 * 任何失败（LLM 报错、解析失败、schema 校验不过、某节点缺设计）都返回
 * null —— 没有教案的旧流程（只读大纲）照常跑。
 */

import { parseJsonResponse } from '@/lib/generation/json-repair';
import { isAbortError } from '@/lib/generation/generation-retry';
import { createLogger } from '@/lib/logger';
import {
  lessonNodeDesignSchema,
  lessonPlanSchema,
  type LessonNode,
  type LessonNodeDesign,
  type LessonPlan,
} from '@/lib/livecourse/domain/schemas';
import {
  runSubagentPool,
  type SubagentPoolOptions,
  type SubagentPoolResult,
  type SubagentRuntime,
  type SubagentTask,
} from '@/lib/livecourse/outline/subagent';
import { goalIdForScene, nodeIdForScene } from '@/lib/livecourse/domain/lesson-plan';
import {
  formatClarificationForPrompt,
  formatSelectedTopicsForPrompt,
  type ClarifyAnswer,
} from '@/lib/livecourse/outline/types';
import type { SceneOutline } from '@/lib/types/generation';
import { buildLessonPlanSkeleton } from './skeleton';

export { buildLessonPlanSkeleton } from './skeleton';

const log = createLogger('Lesson Designer');

export type LessonDesignAICall = (system: string, user: string) => Promise<string>;

export interface DesignLessonPlanInput {
  stageId: string;
  /** Stable course identity. Legacy callers may omit it and use stageId. */
  courseId?: string;
  /** Stable lesson identity. The lesson plan schema does not carry this field,
   * but it is accepted here so callers can keep the generation identity bundle
   * together at the design boundary. */
  lessonId?: string;
  requirement: string;
  courseTitle?: string;
  languageDirective?: string;
  outlines: SceneOutline[];
  clarificationAnswers?: ClarifyAnswer[];
  selectedTopics?: string[];
  visualStyle?: string;
  /** 测试注入用；缺省取当前时间。 */
  now?: string;
}

const SYSTEM_PROMPT = `You are the lesson design agent of a self-paced course generator — a backstage worker. You never talk to the learner.

Given a course requirement and its scene outlines, design the teaching plan for EVERY scene node. For each node produce a "design" object:

- teachingPoints (required): the concrete points this node must teach, in teaching order. 2-6 items, each a single sentence.
- explanationPlan (required): how to teach this node — opening hook, development, recap — one paragraph.
- examples (optional): concrete worked examples.
- anticipatedQuestions (optional, 1-3 items): the questions a self-learner is most likely to get stuck on at this node, each with a prepared response.
- misconceptions (optional): common mistakes or misconceptions that checkpoints should verify.
- oralQuestion (instruction nodes): prepare one short oral reasoning question about the first half of this node, with {"question":"what the teacher asks aloud","guidance":"teacher-only reasoning, likely misconceptions and hints"}. Omit for introductions, recaps and checkpoints. This is a brief formative conversation, not a graded checkpoint. Do not ask about content that has not yet been taught.
- visualAids (optional, at most 3 items, instruction nodes only): declarative image intents for slides where a static visual genuinely helps understanding (diagrams, charts, process illustrations). Omit entirely when text suffices. Each item:
  - id: a globally unique placeholder, format "lesson_img_<sceneId>_<n>" (n starts at 1). Reusing the same id in a later node reuses the same image — do not request near-identical images.
  - prompt: a clear, specific description for the image generation model. If the image contains text, labels, or annotations, the prompt MUST explicitly state that all text in the image is in the course language.
  - purpose (optional): what this image helps the learner understand.
  - aspectRatio (optional): one of "1:1", "16:9", "9:16", "4:3" (default "16:9").

Write ALL content in the language required by the language directive, or in the language of the requirement when no directive is given.

Return ONLY a JSON object, no markdown, no explanation:
{"nodes":[{"sceneId":"<outline id>","design":{"teachingPoints":["..."],"explanationPlan":"...","examples":["..."],"anticipatedQuestions":[{"question":"...","response":"..."}],"misconceptions":["..."],"visualAids":[{"id":"lesson_img_<sceneId>_1","prompt":"...","purpose":"...","aspectRatio":"16:9"}]}}]}

Every outline must appear exactly once, keyed by its sceneId.`;

/**
 * A4 按节点 fan-out 时每个 subagent 的系统 prompt：只为一个节点产出完整
 * design。与 SYSTEM_PROMPT 同为台后 worker 口吻，prompt/日志不出现学习者
 * 可见的第二身份（docs/spec/04-detailed-design.md §7）。
 */
const NODE_SYSTEM_PROMPT = `You are the lesson design agent of a self-paced course generator — a backstage worker. You never talk to the learner.

You are designing the teaching plan for ONE scene node of a lesson. Produce a complete "design" object for this node:

- teachingPoints (required): the concrete points this node must teach, in teaching order. 3-6 items, each a single sentence.
- explanationPlan (required): how to teach this node — opening hook, development, recap — one paragraph.
- examples (optional): concrete worked examples.
- anticipatedQuestions (required): the questions a self-learner is most likely to get stuck on at this node, each with a prepared response. 2-4 items.
- misconceptions (required): common mistakes or misconceptions that checkpoints should verify.
- oralQuestion (instruction nodes): prepare one short oral reasoning question about the first half of this node, with {"question":"what the teacher asks aloud","guidance":"teacher-only reasoning, likely misconceptions and hints"}. Omit for introductions, recaps and checkpoints. This is a brief formative conversation, not a graded checkpoint. Do not ask about content that has not yet been taught.
- visualAids (optional, at most 3 items, instruction nodes only): declarative image intents for slides where a static visual genuinely helps understanding (diagrams, charts, process illustrations). Omit entirely when text suffices. Each item:
  - id: a globally unique placeholder, format "lesson_img_<sceneId>_<n>" (n starts at 1 for this node).
  - prompt: a clear, specific description for the image generation model. If the image contains text, labels, or annotations, the prompt MUST explicitly state that all text in the image is in the course language.
  - purpose (optional): what this image helps the learner understand.
  - aspectRatio (optional): one of "1:1", "16:9", "9:16", "4:3" (default "16:9").

You are given this node's outline entry plus the titles of the previous and next nodes. Teach THIS node only: connect smoothly to its neighbors without repeating their content.

Write ALL content in the language required by the language directive, or in the language of the course requirement when no directive is given.

Return ONLY the design JSON object, no markdown, no explanation:
{"teachingPoints":["..."],"explanationPlan":"...","examples":["..."],"anticipatedQuestions":[{"question":"...","response":"..."}],"misconceptions":["..."],"visualAids":[{"id":"lesson_img_<sceneId>_1","prompt":"...","purpose":"...","aspectRatio":"16:9"}]}`;

function buildUserPrompt(input: DesignLessonPlanInput, ordered: SceneOutline[]): string {
  const outlineLines = ordered
    .map(
      (outline) =>
        `- sceneId: ${outline.id}\n  type: ${outline.type}\n  title: ${outline.title}\n` +
        `  description: ${outline.description}\n` +
        `  keyPoints: ${(outline.keyPoints ?? []).join('; ')}`,
    )
    .join('\n');

  const contextBlocks = [
    formatClarificationForPrompt(input.clarificationAnswers),
    formatSelectedTopicsForPrompt(input.selectedTopics),
  ]
    .filter(Boolean)
    .join('\n\n');

  return [
    `Course requirement:\n${input.requirement}`,
    input.courseTitle?.trim() ? `Course title: ${input.courseTitle.trim()}` : '',
    input.languageDirective?.trim() ? `Language directive: ${input.languageDirective.trim()}` : '',
    contextBlocks,
    input.visualStyle
      ? `Course-wide visual direction (set by the main agent):\n${input.visualStyle}`
      : '',
    `Scene outlines (design exactly one node per outline):\n${outlineLines}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Extract per-node designs from raw LLM JSON. Strict: any malformed entry or
 * schema violation fails the whole plan (return null) rather than shipping a
 * partial lesson design.
 */
function extractDesignsBySceneId(raw: unknown): Map<string, LessonNodeDesign> | null {
  if (!raw || typeof raw !== 'object') return null;
  const nodes = (raw as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return null;

  const designs = new Map<string, LessonNodeDesign>();
  for (const entry of nodes) {
    if (!entry || typeof entry !== 'object') return null;
    const { sceneId, design } = entry as Record<string, unknown>;
    if (typeof sceneId !== 'string' || !sceneId.trim()) return null;
    const parsed = lessonNodeDesignSchema.safeParse(design);
    if (!parsed.success) return null;
    designs.set(sceneId, parsed.data);
  }
  return designs;
}

function orderedOutlines(input: DesignLessonPlanInput): SceneOutline[] | null {
  const ordered = [...input.outlines].sort(
    (left, right) => left.order - right.order || left.id.localeCompare(right.id),
  );
  if (ordered.length === 0 || ordered.some((outline) => !outline.id?.trim())) {
    log.warn('Lesson design skipped: outlines missing or without ids');
    return null;
  }
  return ordered;
}

/**
 * 按 deriveLessonPlanFromStage 的 ID 约定组装 goals/nodes 并过 schema。
 * requireAllDesigns=true（单调用路径）：任一节点缺 design 返回 null。
 * requireAllDesigns=false（A4 fan-out 降级）：缺 design 的节点保留、design
 * 省略（schema 允许节点无 design）。
 */
function assembleLessonPlan(
  input: DesignLessonPlanInput,
  ordered: SceneOutline[],
  designsBySceneId: Map<string, LessonNodeDesign>,
  requireAllDesigns: boolean,
): LessonPlan | null {
  const skeleton = buildLessonPlanSkeleton({ ...input, outlines: ordered });
  const nodes: LessonNode[] = [];
  for (const outline of ordered) {
    const design = designsBySceneId.get(outline.id);
    if (!design && requireAllDesigns) {
      log.warn(`Lesson design missing node for outline "${outline.id}", degrading`);
      return null;
    }
    const skeletonNode = skeleton.nodes.find((node) => node.sceneId === outline.id);
    if (!skeletonNode) throw new Error(`Lesson plan skeleton lost outline ${outline.id}`);
    nodes.push({ ...skeletonNode, ...(design ? { design } : {}) });
  }

  return lessonPlanSchema.parse({ ...skeleton, nodes });
}

/**
 * 设计一堂课的教案。成功返回通过 lessonPlanSchema 校验的 LessonPlan；
 * 任何失败返回 null（降级，不阻塞生成流水线）。
 */
export async function designLessonPlan(
  input: DesignLessonPlanInput,
  aiCall: LessonDesignAICall,
): Promise<LessonPlan | null> {
  try {
    const ordered = orderedOutlines(input);
    if (!ordered) return null;

    const raw = await aiCall(SYSTEM_PROMPT, buildUserPrompt(input, ordered));
    const parsed = parseJsonResponse<unknown>(raw);
    const designsBySceneId = extractDesignsBySceneId(parsed);
    if (!designsBySceneId) {
      log.warn('Lesson design output unusable, degrading to no lesson plan');
      return null;
    }

    return assembleLessonPlan(input, ordered, designsBySceneId, true);
  } catch (error) {
    if (isAbortError(error)) throw error;
    log.warn('Lesson plan design failed, degrading to no lesson plan:', error);
    return null;
  }
}

/** 每个 subagent 的任务正文：课程上下文 + 该节点大纲条目 + 前后节点标题。 */
function buildNodeTask(
  input: DesignLessonPlanInput,
  ordered: SceneOutline[],
  index: number,
): string {
  const outline = ordered[index];
  const previous = ordered[index - 1];
  const next = ordered[index + 1];

  const contextBlocks = [
    formatClarificationForPrompt(input.clarificationAnswers),
    formatSelectedTopicsForPrompt(input.selectedTopics),
  ]
    .filter(Boolean)
    .join('\n\n');

  return [
    `Course requirement:\n${input.requirement}`,
    input.courseTitle?.trim() ? `Course title: ${input.courseTitle.trim()}` : '',
    input.languageDirective?.trim() ? `Language directive: ${input.languageDirective.trim()}` : '',
    contextBlocks,
    input.visualStyle
      ? `Course-wide visual direction (set by the main agent):\n${input.visualStyle}`
      : '',
    `This node's outline entry (design exactly this node):\n` +
      `- sceneId: ${outline.id}\n  type: ${outline.type}\n  title: ${outline.title}\n` +
      `  description: ${outline.description}\n` +
      `  keyPoints: ${(outline.keyPoints ?? []).join('; ')}`,
    previous
      ? `Previous node title (taught right before this one — connect to it, do not repeat its content): ${previous.title}`
      : 'This is the first node of the lesson.',
    next
      ? `Next node title (taught right after this one — leave its content to it): ${next.title}`
      : 'This is the last node of the lesson.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** 解析单个 subagent 的输出为一个节点的 design；不合格按失败节点处理。 */
function parseNodeDesignOutput(raw: string): LessonNodeDesign | null {
  const parsed = parseJsonResponse<unknown>(raw);
  if (!parsed || typeof parsed !== 'object') return null;
  // 宽容接受裸 design 对象或 { "design": {...} } 包裹。
  const candidate =
    'design' in (parsed as Record<string, unknown>)
      ? (parsed as Record<string, unknown>).design
      : parsed;
  const result = lessonNodeDesignSchema.safeParse(candidate);
  return result.success ? result.data : null;
}

/** 可注入的 pool 执行器，默认真实 runSubagentPool；测试注入假池。 */
export type LessonSubagentPoolExecutor = (
  tasks: SubagentTask[],
  runtime: SubagentRuntime,
  options?: SubagentPoolOptions,
) => Promise<SubagentPoolResult>;

/** 小课（≤3 个节点）不值得 fan-out，直接走单调用。 */
export const SUBAGENT_FAN_OUT_MIN_NODES = 4;

/**
 * A4：教案设计按节点并行 subagent（docs/spec/04-detailed-design.md §7、
 * docs/spec/05-development-plan.md A4）。
 *
 * - 节点数 < SUBAGENT_FAN_OUT_MIN_NODES：直接走单调用 designLessonPlan。
 * - 否则每个节点一个 subagent 并行产出该节点的完整 design，代码侧组装校验。
 * - 降级：部分 subagent 失败 → 用现有单调用补这些节点（一次补充调用）；
 *   单调用也失败 → 这些节点保留但无 design（schema 允许）；整体 parse
 *   失败 → 返回 null（与 designLessonPlan 同语义）。
 */
export async function designLessonPlanWithSubagents(
  input: DesignLessonPlanInput,
  runtime: SubagentRuntime,
  aiCall: LessonDesignAICall,
  poolExecutor: LessonSubagentPoolExecutor = runSubagentPool,
): Promise<LessonPlan | null> {
  try {
    const ordered = orderedOutlines(input);
    if (!ordered) return null;

    if (ordered.length < SUBAGENT_FAN_OUT_MIN_NODES) {
      return designLessonPlan(input, aiCall);
    }

    const tasks: SubagentTask[] = ordered.map((outline, index) => ({
      name: `lesson-node:${outline.id}`,
      systemPrompt: NODE_SYSTEM_PROMPT,
      task: buildNodeTask(input, ordered, index),
    }));

    const pool = await poolExecutor(tasks, runtime);

    const designsBySceneId = new Map<string, LessonNodeDesign>();
    const missingOutlines: SceneOutline[] = [];
    for (const outline of ordered) {
      const output = pool.outputs.get(`lesson-node:${outline.id}`);
      const design = output ? parseNodeDesignOutput(output) : null;
      if (design) {
        designsBySceneId.set(outline.id, design);
      } else {
        missingOutlines.push(outline);
      }
    }

    // 降级：一次补充单调用补齐失败节点（subagent 执行失败或输出不合格都算）。
    // 客户端已断开时不要再打一轮补救请求。
    if (missingOutlines.length > 0) {
      if (runtime.abortSignal?.aborted) {
        throw abortError(runtime.abortSignal);
      }
      log.warn(
        `${missingOutlines.length}/${ordered.length} node subagent(s) failed; ` +
          'falling back to a single-call design for them',
      );
      try {
        const raw = await aiCall(SYSTEM_PROMPT, buildUserPrompt(input, missingOutlines));
        const fallback = extractDesignsBySceneId(parseJsonResponse<unknown>(raw));
        if (fallback) {
          for (const outline of missingOutlines) {
            const design = fallback.get(outline.id);
            if (design) designsBySceneId.set(outline.id, design);
          }
        }
      } catch (error) {
        if (isAbortError(error) || runtime.abortSignal?.aborted) throw error;
        log.warn('Fallback single-call lesson design failed:', error);
      }
    }

    return assembleLessonPlan(input, ordered, designsBySceneId, false);
  } catch (error) {
    if (isAbortError(error) || runtime.abortSignal?.aborted) throw error;
    log.warn('Lesson plan design with subagents failed, degrading to no lesson plan:', error);
    return null;
  }
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * 把节点讲授设计格式化为注入场景内容 prompt 的文本块。无设计时返回空串
 *（模板变量给空默认值，占位符不会泄漏给模型）。
 */
export function formatLessonNodeDesignForPrompt(design: LessonNodeDesign | undefined): string {
  if (!design) return '';

  const lines: string[] = [
    "## This Scene's Lesson Design",
    '',
    '讲授要点 (Teaching points — cover all of them, in order):',
    ...design.teachingPoints.map((point, index) => `${index + 1}. ${point}`),
    '',
    `讲解组织 (Explanation plan): ${design.explanationPlan}`,
  ];

  if (design.examples?.length) {
    lines.push('', '例子 (Examples):', ...design.examples.map((example) => `- ${example}`));
  }
  if (design.anticipatedQuestions?.length) {
    lines.push('', '预设学生提问与回应 (Anticipated student questions and planned responses):');
    for (const qa of design.anticipatedQuestions) {
      lines.push(`- Q: ${qa.question}`, `  A: ${qa.response}`);
    }
  }
  if (design.misconceptions?.length) {
    lines.push(
      '',
      '易错点 (Common misconceptions — address them proactively):',
      ...design.misconceptions.map((misconception) => `- ${misconception}`),
    );
  }
  if (design.visualAids?.length) {
    lines.push(
      '',
      '配图设计 (Planned visuals — these images are being generated; reference them by their placeholder ids as image element src):',
      ...design.visualAids.map(
        (aid) =>
          `- ${aid.id}: "${aid.prompt}" (aspect ratio: ${aid.aspectRatio || '16:9'})` +
          (aid.purpose ? ` — purpose: ${aid.purpose}` : ''),
      ),
    );
  }

  lines.push('', 'The generated content must faithfully cover the teaching points above.');
  return lines.join('\n');
}

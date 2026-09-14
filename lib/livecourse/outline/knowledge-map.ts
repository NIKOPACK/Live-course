/**
 * 知识分解 Agent（docs/spec/04-detailed-design.md §7，才新写 A3/A4）。
 *
 * 把主题分解为一层或两层知识点树，供学习者勾选范围。
 * A4 起两段式：先单次调用粗分枝干，再每个枝干派一个并行 subagent 细分
 * （`runKnowledgeMapperWithSubagents`）；任一环节失败降级回单次调用
 * `runKnowledgeMapper`，再失败返回空 topics —— 前端对空 topics 跳过勾选步。
 */

import { parseJsonResponse } from '@/lib/generation/json-repair';
import { createLogger } from '@/lib/logger';
import type { ClarifyAnswer, KnowledgeMap, KnowledgeTopic } from './types';
import { normalizeKnowledgeMap, sanitizeTopic } from './normalizers';
export { normalizeKnowledgeMap } from './normalizers';
import type { OutlineAICall } from './clarify';
import {
  runSubagentPool,
  type SubagentPoolResult,
  type SubagentRuntime,
  type SubagentTask,
} from './subagent';

const log = createLogger('Knowledge Mapper');

export interface KnowledgeMapRunOptions {
  /** Preserve the legacy empty-topic degradation unless a route opts in to strict errors. */
  failureMode?: 'degrade' | 'throw';
  /** Bounded learner-only context; prompt input only, never persisted here. */
  teacherContext?: string;
}

export class KnowledgeMapError extends Error {
  override readonly name = 'KnowledgeMapError';
}

const SYSTEM_PROMPT = `You are the knowledge decomposition agent of a self-paced course generator.

Your job: decompose the learner's topic into a knowledge tree with ONE or TWO levels of topics, so the learner can check the exact scope they want for ONE self-study lesson of 15-30 minutes.

Rules:
- "subject": a precise subject/course name inferred from the requirement (e.g. "高等数学（大一上）"), in the requirement's language.
- Each topic needs: id (stable snake_case), title, a one-sentence summary of what it covers, and "recommended" (boolean).
- Mark recommended=true only for topics that are core AND fit a single lesson; keep the total number of recommended LEAF topics within roughly 8-15 (one lesson's capacity).
- Use "children" for a second level only when it genuinely helps scope selection; leaves carry the checkable detail.
- ALL output text (subject, titles, summaries) MUST be in the same language as the requirement text.

Return ONLY a JSON object, no markdown, no explanation:

{"subject":"...","topics":[{"id":"limits","title":"...","summary":"...","recommended":true,"children":[{"id":"epsilon_delta","title":"...","summary":"...","recommended":false}]}]}`;

function formatAnswers(answers: ClarifyAnswer[] | undefined): string {
  const answered = (answers ?? []).filter((a) => a.selectedLabels.length > 0);
  if (answered.length === 0) return '';
  const lines = answered.map((a) => `- ${a.question}: ${a.selectedLabels.join('、')}`);
  return `\n\nThe learner already answered clarification questions:\n${lines.join('\n')}\nDecompose only within the scope implied by these answers.`;
}

function formatTeacherContext(teacherContext: string | undefined): string {
  const trimmed = teacherContext?.trim();
  return trimmed ? `\n\nLearner context (preferences only):\n${trimmed}` : '';
}

/**
 * Run the knowledge mapper. Failures degrade to an empty topic list so the
 * frontend skips the scope-selection step instead of blocking generation.
 */
export async function runKnowledgeMapper(
  requirement: string,
  answers: ClarifyAnswer[] | undefined,
  aiCall: OutlineAICall,
  options: KnowledgeMapRunOptions = {},
): Promise<KnowledgeMap> {
  const userPrompt = `Learner requirement:\n${requirement}${formatAnswers(answers)}${formatTeacherContext(options.teacherContext)}\n\nDecompose into a knowledge topic tree.`;
  const strict = options.failureMode === 'throw';

  try {
    const raw = await aiCall(SYSTEM_PROMPT, userPrompt);
    const parsed = parseJsonResponse<unknown>(raw);
    const normalized = parsed ? normalizeKnowledgeMap(parsed) : null;
    if (normalized) return normalized;

    if (strict) {
      throw new KnowledgeMapError('Knowledge map service returned an unusable response');
    }
    {
      log.warn('Knowledge map output unusable, degrading to empty topics');
      return { subject: requirement.slice(0, 30), topics: [] };
    }
  } catch (error) {
    if (strict) {
      if (error instanceof KnowledgeMapError) throw error;
      throw new KnowledgeMapError(
        error instanceof Error ? error.message : 'Knowledge map service failed',
      );
    }
    log.warn('Knowledge mapper call failed, degrading to empty topics:', error);
    return { subject: requirement.slice(0, 30), topics: [] };
  }
}

// ==================== 两段式（A4）：粗分枝干 → 并行 subagent 细分 ====================

/** Phase 1 粗分出的枝干。 */
interface KnowledgeBranch {
  id: string;
  title: string;
  summary?: string;
}

/** 可注入的 pool 执行器（测试用），默认指向真实 subagent 池。 */
export type BranchPoolRunner = (
  tasks: SubagentTask[],
  runtime: SubagentRuntime,
) => Promise<SubagentPoolResult>;

/** 一堂课可默认勾选的 recommended 叶子上限（规格 §7：一课容量 8–15）。 */
const MAX_RECOMMENDED_LEAVES = 15;

const BRANCH_SYSTEM_PROMPT = `You are the knowledge decomposition planner of a self-paced course generator.

Your job: split the learner's topic into its major BRANCHES (top-level areas) — a coarse map, not the full detail. Another step will expand each branch separately, so keep branches mutually exclusive and collectively exhaustive for ONE self-study subject.

Rules:
- Produce 3-8 branches (fewer for narrow topics, more for broad ones like "高等数学").
- "subject": a precise subject/course name inferred from the requirement (e.g. "高等数学（大一上）"), in the requirement's language.
- Each branch needs: id (stable snake_case), title, and a one-sentence summary of its scope.
- ALL output text (subject, titles, summaries) MUST be in the same language as the requirement text.

Return ONLY a JSON object, no markdown, no explanation:

{"subject":"...","branches":[{"id":"limits","title":"极限与连续","summary":"..."}]}`;

const BRANCH_EXPAND_SYSTEM_PROMPT = `You are a knowledge decomposition worker of a self-paced course generator.

Your job: expand ONE given branch of a subject into its complete, well-ordered list of subtopics — the checkable detail a learner uses to pick lesson scope.

Rules:
- Expand ONLY the given branch. Do NOT include topics that belong to any other branch of the subject.
- Each subtopic needs: id (stable snake_case), title, a one-sentence summary, and "recommended" (boolean).
- Mark recommended=true only for the 2-4 most core subtopics of THIS branch (the ones a first lesson should cover).
- ALL output text (titles, summaries) MUST be in the same language as the requirement text.

Return ONLY a JSON array, no markdown, no explanation:

[{"id":"epsilon_delta","title":"...","summary":"...","recommended":true}]`;

/** Coerce Phase 1 raw JSON into a branch list + subject, or null if unusable. */
function normalizeBranches(raw: unknown): { subject: string; branches: KnowledgeBranch[] } | null {
  if (!raw || typeof raw !== 'object') return null;
  const map = raw as Record<string, unknown>;
  if (!Array.isArray(map.branches)) return null;
  const branches = map.branches
    .map((b, i): KnowledgeBranch | null => {
      if (!b || typeof b !== 'object') return null;
      const branch = b as Record<string, unknown>;
      if (typeof branch.title !== 'string' || !branch.title.trim()) return null;
      return {
        id:
          typeof branch.id === 'string' && branch.id.trim() ? branch.id.trim() : `branch_${i + 1}`,
        title: branch.title.trim(),
        ...(typeof branch.summary === 'string' && branch.summary.trim()
          ? { summary: branch.summary.trim() }
          : {}),
      };
    })
    .filter((b): b is KnowledgeBranch => b !== null);
  if (branches.length === 0) return null;
  const subject = typeof map.subject === 'string' && map.subject.trim() ? map.subject.trim() : '';
  return { subject, branches };
}

/** 解析某枝干 subagent 的子主题数组；不可用时返回 null（按枝干失败处理）。 */
function parseBranchSubtopics(raw: string, branchId: string): KnowledgeTopic[] | null {
  const parsed = parseJsonResponse<unknown>(raw);
  if (!Array.isArray(parsed)) return null;
  const topics = parsed
    .map((t, i) => sanitizeTopic(t, `${branchId}_sub_${i + 1}`))
    .filter((t): t is KnowledgeTopic => t !== null)
    // 枝干细分只要一层叶子；subagent 越界产出 children 时剥掉
    .map((t) => {
      const { children: _children, ...leaf } = t;
      return leaf;
    });
  return topics.length > 0 ? topics : null;
}

/**
 * 把 recommended 叶子总量截断到上限：按树顺序保留前 N 个 recommended 叶子，
 * 超出的只摘掉 recommended 标记，节点本身保留。
 */
function capRecommendedLeaves(topics: KnowledgeTopic[], max: number): void {
  let count = 0;
  const walk = (nodes: KnowledgeTopic[]) => {
    for (const node of nodes) {
      if (node.children && node.children.length > 0) {
        walk(node.children);
      } else if (node.recommended) {
        count += 1;
        if (count > max) node.recommended = false;
      }
    }
  };
  walk(topics);
}

/**
 * 两段式知识分解（A4）：Phase 1 单次调用粗分枝干，Phase 2 每个枝干派一个
 * 并行 subagent 细分后合并。Phase 1 失败或任一枝干失败 → 回退单调用
 * `runKnowledgeMapper`，确保粗分结果不会冒充完整知识树。
 */
export async function runKnowledgeMapperWithSubagents(
  requirement: string,
  answers: ClarifyAnswer[] | undefined,
  runtime: SubagentRuntime,
  aiCall: OutlineAICall,
  runPool: BranchPoolRunner = (tasks, rt) => runSubagentPool(tasks, rt),
  options: KnowledgeMapRunOptions = {},
): Promise<KnowledgeMap> {
  // Phase 1：粗分枝干（沿用现有 aiCall 路径）
  const branchPrompt = `Learner requirement:\n${requirement}${formatAnswers(answers)}${formatTeacherContext(options.teacherContext)}\n\nSplit into coarse branches.`;

  let coarse: { subject: string; branches: KnowledgeBranch[] } | null = null;
  try {
    const raw = await aiCall(BRANCH_SYSTEM_PROMPT, branchPrompt);
    const parsed = parseJsonResponse<unknown>(raw);
    coarse = parsed ? normalizeBranches(parsed) : null;
  } catch (error) {
    log.warn('Branch split call failed, falling back to single-call mapper:', error);
  }
  if (!coarse) {
    log.warn('Branch split unusable, falling back to single-call mapper');
    return runKnowledgeMapper(requirement, answers, aiCall, options);
  }

  // Phase 2：每个枝干一个 subagent 并行细分
  const branchListText = coarse.branches.map((b) => `- ${b.title}`).join('\n');
  const tasks: SubagentTask[] = coarse.branches.map((branch) => ({
    name: `knowledge-branch:${branch.title}`,
    systemPrompt: BRANCH_EXPAND_SYSTEM_PROMPT,
    task: `Learner requirement:\n${requirement}${formatAnswers(
      answers,
    )}${formatTeacherContext(options.teacherContext)}\n\nThe subject "${coarse!.subject}" was split into these branches:\n${branchListText}\n\nYour branch: "${
      branch.title
    }"${branch.summary ? ` — ${branch.summary}` : ''}\n\nExpand ONLY this branch into its subtopics.`,
  }));

  let pool: SubagentPoolResult;
  try {
    pool = await runPool(tasks, runtime);
  } catch (error) {
    log.warn('Branch subagent pool failed, falling back to single-call mapper:', error);
    return runKnowledgeMapper(requirement, answers, aiCall, options);
  }

  const topics: KnowledgeTopic[] = [];
  let failed = false;
  for (const branch of coarse.branches) {
    const name = `knowledge-branch:${branch.title}`;
    const output = pool.outputs.get(name);
    const children = output ? parseBranchSubtopics(output, branch.id) : null;
    if (children) {
      topics.push({
        id: branch.id,
        title: branch.title,
        ...(branch.summary ? { summary: branch.summary } : {}),
        recommended: false,
        children,
      });
    } else {
      // A4 要求任一枝干 subagent 失败时整体降级为单调用。保留一个
      // 没有 children 的裸父节点会把粗分结果冒充完整知识树，导致范围
      // 覆盖不完整；让单调用重新生成完整树，失败时由其既有 strict /
      // degrade 语义决定如何向调用方报告。
      failed = true;
      if (output)
        log.warn(`Branch "${branch.title}" output unusable; falling back to single-call mapper`);
    }
  }

  if (failed) {
    log.warn('One or more branch subagents failed; falling back to single-call mapper');
    return runKnowledgeMapper(requirement, answers, aiCall, options);
  }

  capRecommendedLeaves(topics, MAX_RECOMMENDED_LEAVES);
  return { subject: coarse.subject, topics };
}

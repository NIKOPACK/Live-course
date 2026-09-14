/**
 * 审校 Agent（docs/spec/04-detailed-design.md §7，才新写 A3）。
 *
 * 大纲组装后检查范围覆盖与顺序，不合格修复一次。
 * 审校/修复的任何失败都放行原大纲 —— 永不阻塞主流程。
 */

import { parseJsonResponse } from '@/lib/generation/json-repair';
import { createLogger } from '@/lib/logger';
import type { SceneOutline } from '@/lib/types/generation';
import type { OutlineReviewIssue, OutlineReviewResult } from './types';
import type { OutlineAICall } from './clarify';

const log = createLogger('Outline Reviewer');

export interface ReviewInput {
  requirement: string;
  selectedTopics?: string[];
  outlines: SceneOutline[];
}

export interface RepairInput extends ReviewInput {
  issues: OutlineReviewIssue[];
}

const REVIEW_SYSTEM_PROMPT = `You are the review agent of a self-paced course generator. You review scene outlines for ONE 15-30 minute self-study lesson.

Check, in order:
1. Scope coverage: when the learner selected topics, every selected topic must be covered and nothing outside the selected scope may be taught.
2. Pedagogical order: scenes must progress from prerequisite to advanced concepts; quizzes must come after the content they assess.
3. Constraints: quiz scenes carry quizConfig; interactive scenes are limited to 1-2 and carry widgetType + widgetOutline.

Return ONLY a JSON object, no markdown, no explanation:

{"pass":true,"issues":[]}

or

{"pass":false,"issues":[{"sceneId":"scene_2","problem":"what is wrong","fix":"how to fix it"}]}`;

const REPAIR_SYSTEM_PROMPT = `You are the repair agent of a self-paced course generator. You receive scene outlines plus review issues. Return the FULL corrected outlines array with every issue fixed, preserving scene ids and the original JSON schema of each scene. Return ONLY the JSON array, no markdown, no explanation.`;

function summarizeOutlines(outlines: SceneOutline[]): string {
  return JSON.stringify(
    outlines.map((o) => ({
      id: o.id,
      type: o.type,
      title: o.title,
      description: o.description,
      keyPoints: o.keyPoints,
      order: o.order,
      ...(o.quizConfig ? { quizConfig: o.quizConfig } : {}),
      ...(o.widgetType ? { widgetType: o.widgetType } : {}),
    })),
  );
}

function normalizeReviewResult(raw: unknown): OutlineReviewResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const result = raw as Record<string, unknown>;
  if (typeof result.pass !== 'boolean') return null;
  const issues: OutlineReviewIssue[] = Array.isArray(result.issues)
    ? result.issues
        .map((i): OutlineReviewIssue | null => {
          if (!i || typeof i !== 'object') return null;
          const issue = i as Record<string, unknown>;
          if (typeof issue.problem !== 'string' || !issue.problem.trim()) return null;
          return {
            ...(typeof issue.sceneId === 'string' && issue.sceneId.trim()
              ? { sceneId: issue.sceneId }
              : {}),
            problem: issue.problem.trim(),
            fix: typeof issue.fix === 'string' ? issue.fix.trim() : '',
          };
        })
        .filter((i): i is OutlineReviewIssue => i !== null)
    : [];
  return { pass: result.pass, issues };
}

function extractOutlinesArray(raw: unknown): SceneOutline[] | null {
  const candidate = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).outlines)
      ? ((raw as Record<string, unknown>).outlines as unknown[])
      : null;
  if (!candidate || candidate.length === 0) return null;
  const valid = candidate.filter(
    (o): o is SceneOutline =>
      !!o && typeof o === 'object' && typeof (o as SceneOutline).title === 'string',
  );
  return valid.length > 0 ? valid : null;
}

function formatScope(requirement: string, selectedTopics?: string[]): string {
  const topics = (selectedTopics ?? []).filter(Boolean);
  const scope = topics.length
    ? `\nLearner-selected scope (must be fully covered, nothing beyond):\n${topics.map((t) => `- ${t}`).join('\n')}`
    : '';
  return `Learner requirement:\n${requirement}${scope}`;
}

/**
 * Review assembled outlines. LLM/parse failures pass open so the outline
 * pipeline is never blocked by review.
 */
export async function reviewOutlines(
  input: ReviewInput,
  aiCall: OutlineAICall,
): Promise<OutlineReviewResult> {
  const userPrompt = `${formatScope(input.requirement, input.selectedTopics)}\n\nScene outlines:\n${summarizeOutlines(input.outlines)}\n\nReview and return the JSON verdict.`;

  try {
    const raw = await aiCall(REVIEW_SYSTEM_PROMPT, userPrompt);
    const parsed = parseJsonResponse<unknown>(raw);
    const normalized = parsed ? normalizeReviewResult(parsed) : null;
    if (!normalized) {
      log.warn('Review output unusable, passing open');
      return { pass: true, issues: [] };
    }
    return normalized;
  } catch (error) {
    log.warn('Review call failed, passing open:', error);
    return { pass: true, issues: [] };
  }
}

/**
 * One repair pass after a failed review. Any failure returns the original
 * outlines unchanged.
 */
export async function repairOutlines(
  input: RepairInput,
  aiCall: OutlineAICall,
): Promise<SceneOutline[]> {
  const userPrompt = `${formatScope(input.requirement, input.selectedTopics)}\n\nCurrent scene outlines:\n${JSON.stringify(input.outlines)}\n\nReview issues to fix:\n${JSON.stringify(input.issues)}\n\nReturn the full corrected outlines array.`;

  try {
    const raw = await aiCall(REPAIR_SYSTEM_PROMPT, userPrompt);
    const parsed = parseJsonResponse<unknown>(raw);
    const repaired = parsed ? extractOutlinesArray(parsed) : null;
    if (!repaired) {
      log.warn('Repair output unusable, keeping original outlines');
      return input.outlines;
    }
    return repaired;
  } catch (error) {
    log.warn('Repair call failed, keeping original outlines:', error);
    return input.outlines;
  }
}

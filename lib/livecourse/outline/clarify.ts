/**
 * 澄清 Agent（docs/spec/04-detailed-design.md §7，才新写 A3）。
 *
 * 判断学习需求是否足够具体、可直接生成一堂 15–30 分钟自学课；
 * 太宽时产出 1–3 道带可选项的澄清问题。任何失败都降级为 ready —— 永不阻塞主流程。
 */

import { parseJsonResponse } from '@/lib/generation/json-repair';
import { createLogger } from '@/lib/logger';
import type { ClarifyOption, ClarifyQuestion, ClarifyResult } from './types';
import { normalizeClarifyResult } from './normalizers';

export { normalizeClarifyResult } from './normalizers';

const log = createLogger('Outline Clarifier');

export type OutlineAICall = (system: string, user: string) => Promise<string>;

export interface OutlineRunOptions {
  /**
   * Keep the historical library behaviour by default. HTTP boundaries use
   * `throw` so the caller can offer an explicit retry/skip choice instead of
   * mistaking an unavailable clarifier for a successful `ready` verdict.
   */
  failureMode?: 'degrade' | 'throw';
}

export class OutlineClarifyError extends Error {
  override readonly name = 'OutlineClarifyError';
}

const SYSTEM_PROMPT = `You are the clarification agent of a self-paced course generator.

Your job: decide whether the learner's requirement is specific enough to directly generate ONE self-study lesson of 15-30 minutes.

A requirement is specific enough when:
- the topic scope is clear enough to teach in 15-30 minutes, AND
- the learner's level or goal for THIS topic can be inferred from the requirement or the learner profile.

A concrete topic such as "chain rule" / "链式法则" is NOT automatically ready if the current level, goal, teaching method, depth, pace, or interaction style is still unknown.

If information is missing AND it would change this lesson's design, produce 1-3 clarification questions. Allowed question kinds:
- Scope (only when the topic is still too broad): multiSelect=true. Options must be concrete and mutually distinguishable.
- This-topic level/goal (beginner vs. exam prep vs. review): multiSelect=false.
- Teaching method, explanation depth, pace, or interaction style: multiSelect=false, only when the requirement and learner profile do not already answer them.

Do NOT ask about anything already stated in the requirement or the learner profile. If the learner already said they want diagrams, few formulas, a slow pace, captions, or a language, do not re-ask those. Prefer status "ready" over repeating known preferences.

Each question has 3-6 options. Every option needs a short id, a label, and optionally a one-line description.
Questions and options MUST be written in the same language as the requirement text.

If the requirement plus learner profile already answer the design-changing questions, return status "ready".

Return ONLY a JSON object, no markdown, no explanation. One of exactly these two shapes:

{"status":"ready","reason":"short reason"}

{"status":"needs_clarification","questions":[{"id":"q1","question":"...","multiSelect":true,"options":[{"id":"a","label":"...","description":"..."}]}]}`;

const READY_FALLBACK: ClarifyResult = { status: 'ready' };

/**
 * Run the clarifier. Parse/LLM failures degrade to ready so the outline
 * pipeline is never blocked by clarification.
 */
export async function runClarifier(
  requirement: string,
  userProfile: string,
  aiCall: OutlineAICall,
  options: OutlineRunOptions = {},
): Promise<ClarifyResult> {
  const userPrompt = `Learner requirement:\n${requirement}\n\n${userProfile ? `Learner profile:\n${userProfile}\n\n` : ''}Decide: ready, or needs_clarification with questions.`;
  const strict = options.failureMode === 'throw';

  try {
    const raw = await aiCall(SYSTEM_PROMPT, userPrompt);
    const parsed = parseJsonResponse<unknown>(raw);
    const normalized = parsed ? normalizeClarifyResult(parsed) : null;
    if (normalized) return normalized;

    if (strict) {
      throw new OutlineClarifyError('Clarification service returned an unusable response');
    }
    {
      log.warn('Clarifier output unusable, degrading to ready');
      return READY_FALLBACK;
    }
  } catch (error) {
    if (strict) {
      if (error instanceof OutlineClarifyError) throw error;
      throw new OutlineClarifyError(
        error instanceof Error ? error.message : 'Clarification service failed',
      );
    }
    log.warn('Clarifier call failed, degrading to ready:', error);
    return READY_FALLBACK;
  }
}

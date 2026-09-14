/**
 * Outline Knowledge Map API
 *
 * POST { requirements: UserRequirements, answers?: ClarifyAnswer[] } → KnowledgeMap
 * 把主题分解为知识点树供学习者勾选范围。
 * LLM 失败返回明确的上游错误，让预览页提供重试或明确跳过。
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { runKnowledgeMapperWithSubagents } from '@/lib/livecourse/outline/knowledge-map';
import type { ClarifyAnswer } from '@/lib/livecourse/outline/types';
import type { UserRequirements } from '@/lib/types/generation';
import { MAX_TOTAL_CONTEXT_CHARS } from '@/lib/livecourse/memory/context';

const log = createLogger('Knowledge Map API');

export const maxDuration = 60;

interface RequestBody {
  requirements?: UserRequirements;
  answers?: ClarifyAnswer[];
  /** Bounded, policy-filtered learner-only context from the new-course boundary. */
  teacherContext?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(req: NextRequest) {
  let requirement = '';
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Request body must be valid JSON');
  }
  if (!isRecord(rawBody)) {
    return apiError('INVALID_REQUEST', 400, 'Request body must be an object');
  }
  const body = rawBody as RequestBody;

  try {
    const { requirements, answers, teacherContext } = body;
    if (!isRecord(requirements) || typeof requirements.requirement !== 'string') {
      return apiError(
        'INVALID_REQUEST',
        400,
        'requirements must be an object with a string requirement',
      );
    }
    requirement = requirements.requirement;

    if (!requirement.trim()) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'requirements.requirement is required');
    }
    if (answers !== undefined && !Array.isArray(answers)) {
      return apiError('INVALID_REQUEST', 400, 'answers must be an array when provided');
    }
    if (
      teacherContext !== undefined &&
      (typeof teacherContext !== 'string' || teacherContext.length > MAX_TOTAL_CONTEXT_CHARS)
    ) {
      return apiError(
        'INVALID_REQUEST',
        400,
        `teacherContext must be a string of at most ${MAX_TOTAL_CONTEXT_CHARS} characters`,
      );
    }

    const { model: languageModel, thinkingConfig } = await resolveModelFromRequest(
      req,
      body,
      'scene-outlines-stream',
    );

    const result = await runKnowledgeMapperWithSubagents(
      requirement,
      answers,
      { languageModel, thinkingConfig },
      async (system, user) =>
        (
          await callLLM(
            { model: languageModel, system, prompt: user },
            'outline-knowledge-map',
            undefined,
            thinkingConfig,
          )
        ).text,
      undefined,
      { failureMode: 'throw', teacherContext },
    );

    return apiSuccess({ ...result });
  } catch (error) {
    log.error('Knowledge map failed:', error);
    return apiError(
      'UPSTREAM_ERROR',
      502,
      'Knowledge map service is unavailable; retry or skip scope confirmation',
    );
  }
}

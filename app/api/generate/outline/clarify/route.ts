/**
 * Outline Clarify API
 *
 * POST { requirements: UserRequirements } → ClarifyResult
 * 判断需求是否足够具体；不够时返回带可选项的澄清问题。
 * 模型解析失败 / LLM 报错返回明确的上游错误，让预览页提供重试或跳过。
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { runClarifier } from '@/lib/livecourse/outline/clarify';
import { MAX_TOTAL_CONTEXT_CHARS } from '@/lib/livecourse/memory/context';
import type { UserRequirements } from '@/lib/types/generation';

const log = createLogger('Outline Clarify API');

export const maxDuration = 60;

interface RequestBody {
  requirements?: UserRequirements;
  /** Bounded, policy-filtered learner-only context from the new-course boundary. */
  teacherContext?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(req: NextRequest) {
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
    const { requirements, teacherContext } = body;

    if (!isRecord(requirements) || typeof requirements.requirement !== 'string') {
      return apiError(
        'INVALID_REQUEST',
        400,
        'requirements must be an object with a string requirement',
      );
    }
    if (!requirements.requirement.trim()) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'requirements.requirement is required');
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

    const profileFromRequirements =
      requirements.userNickname || requirements.userBio
        ? `Student: ${requirements.userNickname || 'Unknown'}${requirements.userBio ? ` — ${requirements.userBio}` : ''}`
        : '';
    const userProfile = [profileFromRequirements, teacherContext?.trim()]
      .filter(Boolean)
      .join('\n\n');

    const result = await runClarifier(
      requirements.requirement,
      userProfile,
      async (system, user) =>
        (
          await callLLM(
            { model: languageModel, system, prompt: user },
            'outline-clarify',
            undefined,
            thinkingConfig,
          )
        ).text,
      { failureMode: 'throw' },
    );

    return apiSuccess({ ...result });
  } catch (error) {
    log.error('Outline clarify failed:', error);
    return apiError(
      'UPSTREAM_ERROR',
      502,
      'Clarification service is unavailable; retry or skip clarification',
    );
  }
}

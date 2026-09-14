/**
 * Lesson Plan Design API (A1 先设计再生成)
 *
 * POST { requirements, outlines, courseId?, stageId, lessonId?, courseTitle?, languageDirective? }
 *   → { lessonPlan: LessonPlan | null }
 *
 * 大纲之后由教案设计 Agent（台后 worker）产出详细 LessonPlan。
 * 旧调用设计失败可降级；HTML 新课必须先成功确定视觉方向，失败显式报错。
 */

import { NextRequest } from 'next/server';
import { callLLM } from '@/lib/ai/llm';
import { isAbortError } from '@/lib/generation/generation-retry';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import { designLessonPlanWithSubagents } from '@/lib/livecourse/lesson/designer';
import { designHtmlLessonPlan } from '@/lib/livecourse/lesson/html-presentation';
import { llmApiError } from '@/lib/server/llm-error-response';
import type { SceneOutline, UserRequirements } from '@/lib/types/generation';

const log = createLogger('Lesson Plan API');

export const maxDuration = 300;

/** One in-flight design per stage so a refresh aborts the previous 14-way fan-out. */
const lessonPlanJobs = new Map<string, AbortController>();

function takeLessonPlanSignal(
  stageId: string,
  requestSignal: AbortSignal,
): {
  signal: AbortSignal;
  release: () => void;
} {
  lessonPlanJobs.get(stageId)?.abort();
  const job = new AbortController();
  lessonPlanJobs.set(stageId, job);
  const onRequestAbort = () => job.abort();
  if (requestSignal.aborted) job.abort();
  else requestSignal.addEventListener('abort', onRequestAbort, { once: true });
  return {
    signal: job.signal,
    release: () => {
      requestSignal.removeEventListener('abort', onRequestAbort);
      if (lessonPlanJobs.get(stageId) === job) lessonPlanJobs.delete(stageId);
    },
  };
}

interface RequestBody {
  requirements?: UserRequirements;
  outlines?: SceneOutline[];
  courseId?: string;
  stageId?: string;
  lessonId?: string;
  courseTitle?: string;
  languageDirective?: string;
  htmlPresentation?: boolean;
}

export async function POST(req: NextRequest) {
  let htmlPresentation = false;
  try {
    const body = (await req.json()) as RequestBody;
    htmlPresentation = body.htmlPresentation === true;
    const { requirements, outlines, courseId, stageId, lessonId, courseTitle, languageDirective } =
      body;

    if (!stageId?.trim()) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'stageId is required');
    }
    if (!Array.isArray(outlines) || outlines.length === 0) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'outlines is required and must not be empty');
    }

    const { model: languageModel, thinkingConfig } = await resolveModelFromRequest(
      req,
      body,
      'lesson-plan',
    );

    const job = takeLessonPlanSignal(stageId.trim(), req.signal);
    try {
      // HTML lessons commit the main agent's style before the existing node fan-out.
      const design = htmlPresentation ? designHtmlLessonPlan : designLessonPlanWithSubagents;
      const lessonPlan = await design(
        {
          stageId,
          courseId,
          lessonId,
          requirement: requirements?.requirement ?? '',
          courseTitle,
          languageDirective,
          outlines,
          clarificationAnswers: requirements?.clarificationAnswers,
          selectedTopics: requirements?.selectedTopics,
        },
        { languageModel, thinkingConfig, abortSignal: job.signal },
        async (system, user) =>
          (
            await callLLM(
              { model: languageModel, system, prompt: user, abortSignal: job.signal },
              'lesson-plan',
              undefined,
              thinkingConfig,
            )
          ).text,
      );

      return apiSuccess({ lessonPlan });
    } finally {
      job.release();
    }
  } catch (error) {
    if (isAbortError(error) || req.signal.aborted) {
      log.warn('Lesson plan cancelled');
      return apiError('GENERATION_FAILED', 499, 'Lesson plan cancelled');
    }
    if (htmlPresentation) {
      log.error('HTML lesson visual direction failed:', error);
      return llmApiError(error);
    }
    log.error('Lesson plan design failed, degrading to null:', error);
    return apiSuccess({ lessonPlan: null });
  }
}

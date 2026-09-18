import type { LanguageModel } from 'ai';
import { collectStreamedCompletion } from '@/lib/ai/llm';
import { thinkingConfigForHtmlClassroom } from '@/lib/ai/thinking-config';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import { isAbortError, withGenerationRetry } from '@/lib/generation/generation-retry';
import {
  ClassroomQualityError,
  ClassroomReviewUnavailableError,
} from '@/lib/livecourse/lesson/quality-review';
import { createLogger } from '@/lib/logger';
import type { ThinkingConfig } from '@/lib/types/provider';

interface ReviewModel {
  model: LanguageModel;
  modelInfo?: { outputWindow?: number } | null;
  thinkingConfig?: ThinkingConfig;
}
const log = createLogger('ClassroomReviewer');

export function createClassroomReviewer(
  resolve: () => Promise<ReviewModel>,
  signal?: AbortSignal,
  purpose: 'review' | 'html-repair' = 'review',
): AICallFn {
  let modelPromise: Promise<ReviewModel> | undefined;
  return async (system, prompt) => {
    signal?.throwIfAborted();
    const resolved = await (modelPromise ??= resolve().catch((error: unknown) => {
      log.error('Could not resolve the classroom-review model', error);
      throw new ClassroomReviewUnavailableError('Classroom reviewer configuration is unavailable', {
        cause: error,
      });
    }));
    try {
      return await withGenerationRetry(
        async () => {
          const thinking = thinkingConfigForHtmlClassroom(true, resolved.thinkingConfig);
          const result = await collectStreamedCompletion(
            {
              model: resolved.model,
              system,
              prompt,
              maxOutputTokens: resolved.modelInfo?.outputWindow,
              abortSignal: signal,
            },
            purpose === 'html-repair' ? 'classroom-review-repair' : 'classroom-review',
            thinking,
          );
          if (
            ['length', 'error', 'content-filter'].includes(result.finishReason) ||
            !result.text.trim()
          ) {
            log.warn('Incomplete final answer', {
              purpose,
              finishReason: result.finishReason,
              finalCharacters: result.text.length,
              reasoningCharacters: result.reasoningText?.length ?? 0,
            });
            throw new ClassroomQualityError(
              'Quality reviewer did not return a complete final answer',
            );
          }
          return result.text;
        },
        {
          label: 'Classroom quality review',
          maxRetries: 2,
          signal,
        },
      );
    } catch (error) {
      if (isAbortError(error) || signal?.aborted || error instanceof ClassroomQualityError)
        throw error;
      log.error('Classroom reviewer request failed after scoped retries', error);
      throw new ClassroomReviewUnavailableError('Classroom reviewer is temporarily unavailable', {
        cause: error,
      });
    }
  };
}

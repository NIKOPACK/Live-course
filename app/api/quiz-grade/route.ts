/**
 * Quiz Grading API
 *
 * POST: Receives a text question + user answer, calls LLM for scoring and feedback.
 * Used for short-answer (text) questions that cannot be graded locally.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { callLLM } from '@/lib/ai/llm';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
const log = createLogger('Quiz Grade');

interface GradeRequest {
  question: string;
  userAnswer: string;
  points: number;
  commentPrompt?: string;
  language?: string;
}

interface GradeResponse {
  score: number;
  comment: string;
}

const gradeRequestSchema = z.object({
  question: z.string().trim().min(1),
  userAnswer: z.string().trim().min(1),
  points: z.number().int().positive(),
  commentPrompt: z.string().optional(),
  language: z.string().optional(),
});

function parseGradeResponse(text: string, points: number): GradeResponse | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  const parsed = z
    .object({
      score: z.number().int().min(0).max(points),
      comment: z.string().trim().min(1),
    })
    .strict()
    .safeParse(value);

  return parsed.success ? parsed.data : null;
}

export async function POST(req: NextRequest) {
  let questionSnippet: string | undefined;
  let resolvedPoints: number | undefined;
  try {
    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return apiError('INVALID_REQUEST', 400, 'Request body must be valid JSON');
    }

    const parsedBody = gradeRequestSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      const candidate = rawBody as Partial<GradeRequest> | null;
      const hasQuestion =
        typeof candidate?.question === 'string' && candidate.question.trim().length > 0;
      const hasUserAnswer =
        typeof candidate?.userAnswer === 'string' && candidate.userAnswer.trim().length > 0;
      if (!hasQuestion || !hasUserAnswer) {
        return apiError('MISSING_REQUIRED_FIELD', 400, 'question and userAnswer are required');
      }
      return apiError('INVALID_REQUEST', 400, 'points must be a positive integer');
    }

    const body: GradeRequest = parsedBody.data;
    const { question, userAnswer, points, commentPrompt, language } = body;
    questionSnippet = question.substring(0, 60);
    resolvedPoints = points;

    // Resolve model from request headers/body
    const { model: languageModel, thinkingConfig } = await resolveModelFromRequest(
      req,
      rawBody,
      'quiz-grade',
    );

    const isZh = language === 'zh-CN';

    const systemPrompt = isZh
      ? `你是一位专业的教育评估专家。请根据题目和学生答案进行评分并给出简短评语。
必须以如下 JSON 格式回复（不要包含其他内容）：
{"score": <0到${points}的整数>, "comment": "<一两句评语>"}`
      : `You are a professional educational assessor. Grade the student's answer and provide brief feedback.
You must reply in the following JSON format only (no other content):
{"score": <integer from 0 to ${points}>, "comment": "<one or two sentences of feedback>"}`;

    const userPrompt = isZh
      ? `题目：${question}
满分：${points}分
${commentPrompt ? `评分要点：${commentPrompt}\n` : ''}学生答案：${userAnswer}`
      : `Question: ${question}
Full marks: ${points} points
${commentPrompt ? `Grading guidance: ${commentPrompt}\n` : ''}Student answer: ${userAnswer}`;

    try {
      const result = await callLLM(
        {
          model: languageModel,
          system: systemPrompt,
          prompt: userPrompt,
        },
        'quiz-grade',
        undefined,
        thinkingConfig,
      );
      const gradeResult =
        typeof result.text === 'string' ? parseGradeResponse(result.text.trim(), points) : null;
      if (!gradeResult) {
        return apiError('PARSE_FAILED', 502, 'Quiz grading service returned an invalid response');
      }

      return apiSuccess({ ...gradeResult });
    } catch (error) {
      log.error(
        `Quiz grading upstream failed [question="${questionSnippet ?? 'unknown'}...", points=${points}]:`,
        error,
      );
      return apiError('UPSTREAM_ERROR', 502, 'Quiz grading service failed');
    }
  } catch (error) {
    log.error(
      `Quiz grading failed [question="${questionSnippet ?? 'unknown'}...", points=${resolvedPoints ?? 'unknown'}]:`,
      error,
    );
    return apiError('INTERNAL_ERROR', 500, 'Failed to grade answer');
  }
}

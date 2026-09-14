import { after, type NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import { runClassroomGenerationJob } from '@/lib/server/classroom-job-runner';
import { createClassroomGenerationJob } from '@/lib/server/classroom-job-store';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';

const log = createLogger('GenerateClassroom API');

export const maxDuration = 30;

const generateClassroomRequestSchema = z
  .object({
    requirement: z.string().trim().min(1),
    pdfContent: z
      .object({
        text: z.string(),
        images: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();

function findForbiddenHeader(headers: Headers): string | undefined {
  for (const [name] of headers) {
    const normalized = name.toLowerCase();
    if (
      normalized === 'api-key' ||
      normalized.includes('api-key') ||
      normalized.includes('access-key') ||
      normalized.includes('provider') ||
      normalized.includes('base-url') ||
      normalized === 'x-model' ||
      normalized.endsWith('-model')
    ) {
      return name;
    }
  }
  return undefined;
}

export async function POST(req: NextRequest) {
  let requirementSnippet: string | undefined;
  try {
    const forbiddenHeader = findForbiddenHeader(req.headers);
    if (forbiddenHeader) {
      return apiError(
        'INVALID_REQUEST',
        400,
        `Client-supplied provider or credential header is not allowed: ${forbiddenHeader}`,
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return apiError('INVALID_REQUEST', 400, 'Request body must be valid JSON');
    }

    const parsedBody = generateClassroomRequestSchema.safeParse(rawBody);
    const rawRequirement =
      typeof rawBody === 'object' && rawBody !== null && !Array.isArray(rawBody)
        ? (rawBody as Record<string, unknown>).requirement
        : undefined;
    if (typeof rawRequirement !== 'string' || !rawRequirement.trim()) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing required field: requirement');
    }
    if (!parsedBody.success) {
      return apiError(
        'INVALID_REQUEST',
        400,
        'Only requirement and valid pdfContent fields are accepted',
      );
    }

    requirementSnippet = parsedBody.data.requirement.substring(0, 60);
    const body: GenerateClassroomInput = {
      ...parsedBody.data,
      enableWebSearch: false,
      enableImageGeneration: false,
      enableVideoGeneration: false,
      enableTTS: false,
      agentMode: 'default',
    };

    const baseUrl = buildRequestOrigin(req);
    const jobId = nanoid(10);
    const job = await createClassroomGenerationJob(jobId, body);
    const pollUrl = `${baseUrl}/api/generate-classroom/${jobId}`;

    after(() => runClassroomGenerationJob(jobId, body, baseUrl));

    return apiSuccess(
      {
        jobId,
        status: job.status,
        step: job.step,
        message: job.message,
        pollUrl,
        pollIntervalMs: 5000,
      },
      202,
    );
  } catch (error) {
    log.error(
      `Classroom generation job creation failed [requirement="${requirementSnippet ?? 'unknown'}..."]:`,
      error,
    );
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to create classroom generation job',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}

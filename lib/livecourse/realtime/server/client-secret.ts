import { createHash } from 'node:crypto';
import { z } from 'zod';
import { buildRealtimeTeacherInstructions } from '@/lib/livecourse/realtime/teacher-instructions';

import {
  realtimeClientSecretRequestSchema,
  realtimeClientSecretResponseSchema,
  type RealtimeClientSecretRequest,
  type RealtimeClientSecretResponse,
} from '@/lib/livecourse/realtime/contracts';

const OPENAI_REALTIME_CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
const DEFAULT_REALTIME_MODEL = 'gpt-realtime-2.1';
const DEFAULT_REALTIME_VOICE = 'marin';
const CLIENT_SECRET_TTL_SECONDS = 600;

const openAIClientSecretResponseSchema = z
  .object({
    value: z.string().trim().min(1),
    expires_at: z.number().int().positive(),
  })
  .passthrough();

export class RealtimeConfigurationError extends Error {
  override readonly name = 'RealtimeConfigurationError';
}

export class RealtimeUpstreamError extends Error {
  override readonly name = 'RealtimeUpstreamError';

  constructor(readonly status: number) {
    super(`Realtime client secret request failed with status ${status}`);
  }
}

interface CreateRealtimeClientSecretDeps {
  fetchImpl?: typeof fetch;
  apiKey?: string;
}

function safetyIdentifier(learnerId: string): string {
  return createHash('sha256').update(learnerId).digest('hex');
}

function buildInstructions(input: RealtimeClientSecretRequest): string {
  return buildRealtimeTeacherInstructions(
    `Course id: ${input.courseId}. Lesson id: ${input.lessonId}.`,
  );
}

function upstreamBody(input: RealtimeClientSecretRequest) {
  return {
    expires_after: {
      anchor: 'created_at',
      seconds: CLIENT_SECRET_TTL_SECONDS,
    },
    session: {
      type: 'realtime',
      model: DEFAULT_REALTIME_MODEL,
      instructions: buildInstructions(input),
      output_modalities: ['audio'],
      tool_choice: 'auto',
      max_output_tokens: 2_048,
      audio: {
        input: {
          transcription: { model: 'gpt-4o-mini-transcribe' },
          turn_detection: {
            type: 'semantic_vad',
            eagerness: 'auto',
            create_response: false,
            interrupt_response: false,
          },
        },
        output: {
          voice: DEFAULT_REALTIME_VOICE,
        },
      },
    },
  };
}

export async function createRealtimeClientSecret(
  rawInput: unknown,
  learnerId: string,
  deps: CreateRealtimeClientSecretDeps = {},
): Promise<RealtimeClientSecretResponse> {
  const input = realtimeClientSecretRequestSchema.parse(rawInput);
  const apiKey = [deps.apiKey, process.env.OPENAI_API_KEY, input.apiKey]
    .map((value) => value?.trim())
    .find(Boolean);
  if (!apiKey) throw new RealtimeConfigurationError('OPENAI_API_KEY is not configured');

  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(OPENAI_REALTIME_CLIENT_SECRETS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Safety-Identifier': safetyIdentifier(learnerId),
      },
      body: JSON.stringify(upstreamBody(input)),
      cache: 'no-store',
    });
  } catch {
    throw new RealtimeUpstreamError(0);
  }

  if (!response.ok) throw new RealtimeUpstreamError(response.status);

  try {
    const payload = openAIClientSecretResponseSchema.parse(await response.json());
    if (payload.value === apiKey) throw new RealtimeUpstreamError(response.status);
    return realtimeClientSecretResponseSchema.parse({
      value: payload.value,
      expiresAt: payload.expires_at,
      model: DEFAULT_REALTIME_MODEL,
      voice: DEFAULT_REALTIME_VOICE,
    });
  } catch {
    throw new RealtimeUpstreamError(response.status);
  }
}

import { z } from 'zod';

/** Official full-duplex Seed-LiveVoice API: https://docs.volcengine.com/docs/6561/2549778 */
export const VOLC_REALTIME_URL = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue';
export const VOLC_REALTIME_RESOURCE_ID = 'volc.speech.dialog';
export const VOLC_REALTIME_MODEL = '1.2.6.1';
export const VOLC_REALTIME_VOICE = 'zh_female_vv_jupiter_bigtts';
export const VOLC_REALTIME_STUDENT_VOICE = 'zh_male_xiaotian_jupiter_bigtts';
export const VOLC_INPUT_SAMPLE_RATE = 16_000;
export const VOLC_OUTPUT_SAMPLE_RATE = 24_000;
export const VOLC_INPUT_FRAME_MS = 20;
export const VOLC_INPUT_FRAME_BYTES =
  (VOLC_INPUT_SAMPLE_RATE * VOLC_INPUT_FRAME_MS * Int16Array.BYTES_PER_ELEMENT) / 1_000;

const sessionIdSchema = z.string().trim().min(1).max(128);
export const volcRealtimeVoiceSchema = z.enum([VOLC_REALTIME_VOICE, VOLC_REALTIME_STUDENT_VOICE]);
export type VolcRealtimeVoice = z.infer<typeof volcRealtimeVoiceSchema>;

export const volcRealtimeActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('connect'),
      instructions: z.string().trim().min(1).max(12_000),
      voice: volcRealtimeVoiceSchema.optional(),
      /** Optional learner-saved key. Ignored when VOLCENGINE_REALTIME_API_KEY is set. */
      apiKey: z.string().max(2_000).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('audio'),
      sessionId: sessionIdSchema,
      audio: z.string().min(1).max(256_000),
    })
    .strict(),
  z
    .object({
      action: z.literal('update'),
      sessionId: sessionIdSchema,
      instructions: z.string().trim().min(1).max(12_000),
    })
    .strict(),
  z
    .object({
      action: z.literal('text'),
      sessionId: sessionIdSchema,
      text: z.string().trim().min(1).max(4_000),
    })
    .strict(),
  z
    .object({
      action: z.literal('commit'),
      sessionId: sessionIdSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('cancel'),
      sessionId: sessionIdSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('close'),
      sessionId: sessionIdSchema,
    })
    .strict(),
]);

export type VolcRealtimeAction = z.infer<typeof volcRealtimeActionSchema>;

export interface VolcRealtimeUpstreamEvent {
  type?: string;
  [key: string]: unknown;
}

export type VolcRealtimeRelayEvent =
  | { type: 'local.connected'; sessionId: string; logId?: string }
  | { type: 'local.closed' }
  | { type: 'local.error'; message: string }
  | { type: 'upstream.event'; event: VolcRealtimeUpstreamEvent };

export function buildVolcSessionCreate(
  instructions: string,
  voice: VolcRealtimeVoice = VOLC_REALTIME_VOICE,
) {
  return {
    type: 'session.create',
    session: {
      model: VOLC_REALTIME_MODEL,
      instructions,
      audio: {
        input: {
          format: {
            type: 'pcm',
            sample_rate: VOLC_INPUT_SAMPLE_RATE,
          },
        },
        output: {
          format: {
            type: 'pcm_s16le',
            sample_rate: VOLC_OUTPUT_SAMPLE_RATE,
          },
          voice,
        },
      },
      tools: [],
    },
    extension: {
      extra: {
        enable_proactive_speak: false,
      },
    },
  } as const;
}

export function extractVolcEventText(event: VolcRealtimeUpstreamEvent): string {
  for (const key of ['delta', 'text', 'transcript', 'content'] as const) {
    const value = event[key];
    if (typeof value === 'string') return value;
  }

  const item = event.item;
  if (item && typeof item === 'object') {
    const text = (item as Record<string, unknown>).text;
    if (typeof text === 'string') return text;
  }

  return '';
}

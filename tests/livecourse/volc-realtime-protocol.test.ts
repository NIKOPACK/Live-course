import { describe, expect, it } from 'vitest';

import { downsampleToPcm16 } from '@/lib/livecourse/realtime/volc/client';
import {
  buildVolcSessionCreate,
  extractVolcEventText,
  isVolcSessionFailure,
  volcRealtimeActionSchema,
  VOLC_INPUT_FRAME_BYTES,
  VOLC_REALTIME_MODEL,
  VOLC_REALTIME_STUDENT_VOICE,
  VOLC_REALTIME_VOICE,
} from '@/lib/livecourse/realtime/volc/protocol';

describe('Volc realtime protocol', () => {
  it('requires fresh sessions for provider 5xx failures but not parameter or unspecified turn errors', () => {
    expect(
      isVolcSessionFailure({ error: { code: '55000000', message: 'Internal Server Error' } }),
    ).toBe(true);
    expect(
      isVolcSessionFailure({ error: { code: '40000001', message: 'Invalid parameter' } }),
    ).toBe(false);
    expect(isVolcSessionFailure({ message: 'Volc realtime failed' })).toBe(false);
  });
  it('requires a valid input generation for mute controls without breaking legacy audio uploads', () => {
    expect(
      volcRealtimeActionSchema.parse({
        action: 'input',
        sessionId: 'session-1',
        enabled: false,
        generation: 2,
      }),
    ).toMatchObject({ enabled: false, generation: 2 });
    expect(
      volcRealtimeActionSchema.safeParse({
        action: 'input',
        sessionId: 'session-1',
        enabled: false,
      }).success,
    ).toBe(false);
    expect(
      volcRealtimeActionSchema.safeParse({
        action: 'audio',
        sessionId: 'session-1',
        audio: 'AAE=',
        generation: -1,
      }).success,
    ).toBe(false);
    expect(
      volcRealtimeActionSchema.safeParse({
        action: 'audio',
        sessionId: 'session-1',
        audio: 'AAE=',
      }).success,
    ).toBe(true);
  });
  it('pins the Seeduplex model and documented PCM formats in one session payload', () => {
    const payload = buildVolcSessionCreate('Teach backpropagation');

    expect(payload).toMatchObject({
      type: 'session.create',
      session: {
        model: VOLC_REALTIME_MODEL,
        instructions: 'Teach backpropagation',
        audio: {
          input: { format: { type: 'pcm', sample_rate: 16_000 } },
          output: {
            format: { type: 'pcm_s16le', sample_rate: 24_000 },
            voice: VOLC_REALTIME_VOICE,
          },
        },
      },
      extension: { extra: { enable_proactive_speak: false } },
    });
  });

  it('builds a student session with the supported male voice', () => {
    const payload = buildVolcSessionCreate('Read the student turn', VOLC_REALTIME_STUDENT_VOICE);

    expect(payload.session.audio.output.voice).toBe(VOLC_REALTIME_STUDENT_VOICE);
    expect(
      volcRealtimeActionSchema.parse({
        action: 'connect',
        instructions: 'Read the student turn',
        voice: VOLC_REALTIME_STUDENT_VOICE,
      }),
    ).toMatchObject({ voice: VOLC_REALTIME_STUDENT_VOICE });
  });

  it('downsamples browser audio to signed 16-bit little-endian PCM', () => {
    const input = new Float32Array([1, 1, 0, 0, -1, -1]);
    const bytes = downsampleToPcm16(input, 48_000, 16_000);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect(bytes).toHaveLength(4);
    expect(view.getInt16(0, true)).toBeGreaterThan(20_000);
    expect(view.getInt16(2, true)).toBeLessThan(-20_000);
    expect(VOLC_INPUT_FRAME_BYTES).toBe(640);
  });

  it('reads both text deltas and completed transcript fields', () => {
    expect(extractVolcEventText({ type: 'response.output_text.delta', delta: '梯度' })).toBe(
      '梯度',
    );
    expect(
      extractVolcEventText({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: '为什么要乘局部导数',
      }),
    ).toBe('为什么要乘局部导数');
  });

  it('accepts a bounded server-relayed narration text action', () => {
    expect(
      volcRealtimeActionSchema.parse({
        action: 'text',
        sessionId: 'session-1',
        text: '误差会沿计算图逐段乘上局部导数。',
      }),
    ).toEqual({
      action: 'text',
      sessionId: 'session-1',
      text: '误差会沿计算图逐段乘上局部导数。',
    });
  });

  it('accepts a learner query as a separate action from scripted narration', () => {
    expect(
      volcRealtimeActionSchema.parse({
        action: 'query',
        sessionId: 'session-1',
        text: '傅里叶变换和拉普拉斯变换有什么区别？',
      }),
    ).toEqual({
      action: 'query',
      sessionId: 'session-1',
      text: '傅里叶变换和拉普拉斯变换有什么区别？',
    });
  });
});

import { describe, expect, it } from 'vitest';

import { downsampleToPcm16 } from '@/lib/livecourse/realtime/volc/client';
import {
  buildVolcSessionCreate,
  extractVolcEventText,
  volcRealtimeActionSchema,
  VOLC_INPUT_FRAME_BYTES,
  VOLC_REALTIME_MODEL,
  VOLC_REALTIME_STUDENT_VOICE,
  VOLC_REALTIME_VOICE,
} from '@/lib/livecourse/realtime/volc/protocol';

describe('Volc realtime protocol', () => {
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
});

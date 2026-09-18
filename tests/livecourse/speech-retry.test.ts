import { describe, expect, it, vi } from 'vitest';

import {
  isRetryableRealtimeSpeechError,
  withRealtimeSpeechRetry,
} from '@/lib/livecourse/realtime/client/speech-retry';

describe('isRetryableRealtimeSpeechError', () => {
  it('retries transient voice-model failures', () => {
    expect(isRetryableRealtimeSpeechError(new Error('Volc realtime failed'))).toBe(true);
    expect(isRetryableRealtimeSpeechError(new Error('Volc model narration timed out'))).toBe(true);
    expect(
      isRetryableRealtimeSpeechError(new Error('Volc realtime event stream disconnected')),
    ).toBe(true);
    expect(
      isRetryableRealtimeSpeechError(new Error('Volc realtime session is not connected')),
    ).toBe(true);
    expect(
      isRetryableRealtimeSpeechError(new Error('Realtime teacher transport disconnected')),
    ).toBe(true);
    expect(isRetryableRealtimeSpeechError({ status: 502 })).toBe(true);
    expect(isRetryableRealtimeSpeechError(new Error('sami error: codes=52000033'))).toBe(true);
    expect(isRetryableRealtimeSpeechError(new Error('AudioServerNoAudioInputTooLongError'))).toBe(
      true,
    );
    expect(isRetryableRealtimeSpeechError(new Error('Volc model question was interrupted'))).toBe(
      true,
    );
  });

  it('does not retry cancellation, auth, or configuration errors', () => {
    expect(isRetryableRealtimeSpeechError(new DOMException('Aborted', 'AbortError'))).toBe(false);
    expect(isRetryableRealtimeSpeechError(new Error('Volc model narration was interrupted'))).toBe(
      false,
    );
    expect(isRetryableRealtimeSpeechError(new Error('Realtime speech was cancelled'))).toBe(false);
    expect(
      isRetryableRealtimeSpeechError(new Error('VOLCENGINE_REALTIME_API_KEY is not configured')),
    ).toBe(false);
    expect(isRetryableRealtimeSpeechError({ statusCode: 401 })).toBe(false);
  });
});

describe('withRealtimeSpeechRetry', () => {
  it('retries a voice-model error then succeeds', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('Volc realtime failed'))
      .mockResolvedValueOnce('ok');
    await expect(
      withRealtimeSpeechRetry(operation, {
        label: 'test.speak',
        sleep: async () => undefined,
        random: () => 0,
      }),
    ).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('stops after retries are exhausted', async () => {
    const operation = vi.fn(async () => {
      throw new Error('Volc model narration timed out');
    });
    await expect(
      withRealtimeSpeechRetry(operation, {
        label: 'test.speak',
        maxRetries: 2,
        sleep: async () => undefined,
        random: () => 0,
      }),
    ).rejects.toThrow('timed out');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('does not retry an interrupted turn', async () => {
    const operation = vi.fn(async () => {
      throw new Error('Volc model narration was interrupted');
    });
    await expect(
      withRealtimeSpeechRetry(operation, {
        label: 'test.speak',
        sleep: async () => undefined,
        random: () => 0,
      }),
    ).rejects.toThrow('interrupted');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

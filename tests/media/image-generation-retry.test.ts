import { describe, expect, it, vi } from 'vitest';
import {
  generateImageWithTimeoutRetry,
  imageGenerationErrorStatus,
  isRetryableImageTimeoutError,
} from '@/lib/media/image-generation-retry';

const CLOUDFLARE_524 = `OpenAI image generation failed (524): <!DOCTYPE html>
<title>1for.cc | 524: A timeout occurred</title>`;

describe('image generation timeout retry', () => {
  it('reads HTTP status from failed (NNN) adapter errors', () => {
    expect(imageGenerationErrorStatus(new Error(CLOUDFLARE_524))).toBe(524);
    expect(
      imageGenerationErrorStatus(new Error('OpenAI image generation failed (401): Invalid token')),
    ).toBe(401);
    expect(imageGenerationErrorStatus({ statusCode: 502 })).toBe(502);
  });

  it('retries gateway timeouts and transport drops', () => {
    expect(isRetryableImageTimeoutError(new Error(CLOUDFLARE_524))).toBe(true);
    expect(isRetryableImageTimeoutError({ status: 502 })).toBe(true);
    expect(isRetryableImageTimeoutError({ statusCode: 503 })).toBe(true);
    expect(isRetryableImageTimeoutError({ statusCode: 504 })).toBe(true);
    expect(isRetryableImageTimeoutError({ statusCode: 408 })).toBe(true);
    expect(isRetryableImageTimeoutError(new Error('fetch failed: ECONNRESET'))).toBe(true);
    expect(isRetryableImageTimeoutError({ name: 'TimeoutError' })).toBe(true);
  });

  it('does not retry auth, validation, content filters, poll budgets, or abort', () => {
    expect(
      isRetryableImageTimeoutError(
        new Error('OpenAI image generation failed (401): Invalid token'),
      ),
    ).toBe(false);
    expect(
      isRetryableImageTimeoutError(new Error('OpenAI image generation failed (400): bad request')),
    ).toBe(false);
    expect(
      isRetryableImageTimeoutError(
        new Error('OpenAI image generation failed (400): OutputImageSensitiveContentDetected'),
      ),
    ).toBe(false);
    expect(isRetryableImageTimeoutError(new Error('ComfyUI generation timed out after 300s'))).toBe(
      false,
    );
    expect(isRetryableImageTimeoutError({ statusCode: 429 })).toBe(false);
    expect(isRetryableImageTimeoutError({ name: 'AbortError' })).toBe(false);
  });

  it('resends once after a 524 then returns the successful image', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error(CLOUDFLARE_524))
      .mockResolvedValueOnce({
        url: 'https://cdn.example.com/cover.png',
        width: 1024,
        height: 576,
      });
    const sleep = vi.fn(async () => undefined);
    const onRetry = vi.fn();

    const result = await generateImageWithTimeoutRetry(operation, { sleep, onRetry });

    expect(result).toEqual({
      url: 'https://cdn.example.com/cover.png',
      width: 1024,
      height: 576,
    });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        maxAttempts: 2,
        reason: 'HTTP 524',
      }),
    );
  });

  it('does not resend a 401', async () => {
    const unauthorized = new Error('OpenAI image generation failed (401): Invalid token');
    const operation = vi.fn().mockRejectedValue(unauthorized);
    const sleep = vi.fn(async () => undefined);

    await expect(generateImageWithTimeoutRetry(operation, { sleep })).rejects.toBe(unauthorized);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after one retry if the upstream still times out', async () => {
    const timeout = new Error(CLOUDFLARE_524);
    const operation = vi.fn().mockRejectedValue(timeout);
    const sleep = vi.fn(async () => undefined);

    await expect(generateImageWithTimeoutRetry(operation, { sleep })).rejects.toBe(timeout);
    expect(operation).toHaveBeenCalledTimes(2);
  });
});

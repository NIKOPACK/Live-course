import {
  isAbortError,
  withGenerationRetry,
  type GenerationRetryOptions,
} from '@/lib/generation/generation-retry';

/** One extra attempt. Upstream 524 already waited ~100s; two tries stay inside the image route budget. */
export const IMAGE_TIMEOUT_MAX_RETRIES = 1;
export const IMAGE_TIMEOUT_RETRY_DELAY_MS = 1000;

const RETRYABLE_HTTP_STATUS = new Set([408, 502, 503, 504, 524]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function messageFrom(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (!isRecord(value)) return String(value);
  const message = value.message;
  return typeof message === 'string' ? message : '';
}

export function imageGenerationErrorStatus(error: unknown): number | undefined {
  if (isRecord(error)) {
    for (const key of ['statusCode', 'status', 'status_code']) {
      const raw = error[key];
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      if (typeof raw === 'string') {
        const parsed = Number.parseInt(raw, 10);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }

  const message = messageFrom(error);
  const failed = message.match(/failed\s*\((\d{3})\)/i);
  if (failed) {
    const status = Number.parseInt(failed[1], 10);
    if (status >= 400 && status <= 599) return status;
  }
  const http = message.match(/\bHTTP\s+(\d{3})\b/i);
  if (http) {
    const status = Number.parseInt(http[1], 10);
    if (status >= 400 && status <= 599) return status;
  }
  return undefined;
}

function annotateStatus(error: unknown): unknown {
  const status = imageGenerationErrorStatus(error);
  if (status !== undefined && isRecord(error) && typeof error.statusCode !== 'number') {
    error.statusCode = status;
  }
  return error;
}

/**
 * Retry Cloudflare/gateway timeouts and transport drops.
 * Do not retry auth, 4xx validation, content filters, or local poll budgets
 * (`timed out after N polls` / `Generation timed out after`).
 */
export function isRetryableImageTimeoutError(error: unknown): boolean {
  if (isAbortError(error)) return false;

  const status = imageGenerationErrorStatus(error);
  if (status !== undefined) return RETRYABLE_HTTP_STATUS.has(status);

  const message = messageFrom(error);
  if (/timed out after/i.test(message)) return false;

  if (isRecord(error) && error.name === 'TimeoutError') return true;
  if (error instanceof Error && error.name === 'TimeoutError') return true;

  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EPIPE|fetch failed|socket hang up|\b524\b.*timeout|timeout occurred/i.test(
    message,
  );
}

export async function generateImageWithTimeoutRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options?: Pick<GenerationRetryOptions<T>, 'signal' | 'sleep' | 'random' | 'onRetry'>,
): Promise<T> {
  return withGenerationRetry(
    async (attempt) => {
      try {
        return await operation(attempt);
      } catch (error) {
        annotateStatus(error);
        throw error;
      }
    },
    {
      label: 'image-generation',
      maxRetries: IMAGE_TIMEOUT_MAX_RETRIES,
      baseDelayMs: IMAGE_TIMEOUT_RETRY_DELAY_MS,
      maxDelayMs: IMAGE_TIMEOUT_RETRY_DELAY_MS,
      shouldRetryError: isRetryableImageTimeoutError,
      signal: options?.signal,
      sleep: options?.sleep,
      random: options?.random ?? (() => 0),
      onRetry: options?.onRetry,
    },
  );
}

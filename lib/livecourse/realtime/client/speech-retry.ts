import { isAbortError, isRetryableGenerationError } from '@/lib/generation/generation-retry';

const SPEECH_MAX_RETRIES = 2;
const SPEECH_BASE_DELAY_MS = 400;
const SPEECH_MAX_DELAY_MS = 2_000;

const NON_RETRYABLE_SPEECH =
  /aborted|cancelled|interrupted|not configured|unconfigured|invalid|unauthorized|forbidden|not allowed/i;

const RETRYABLE_SPEECH =
  /timed out|timeout|disconnected|not connected|session not found|realtime failed|request failed|handshake failed|connection timed out|did not start within|playback timed out|already speaking|rate limit|too many requests|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|network|502|503|504/i;

export function isRetryableRealtimeSpeechError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (NON_RETRYABLE_SPEECH.test(message)) return false;
  if (RETRYABLE_SPEECH.test(message)) return true;
  return isRetryableGenerationError(error);
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export async function withRealtimeSpeechRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    label: string;
    signal?: AbortSignal;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    random?: () => number;
    onRetry?: (event: {
      label: string;
      attempt: number;
      maxAttempts: number;
      nextDelayMs: number;
      reason: string;
    }) => Promise<void> | void;
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  },
): Promise<T> {
  const maxRetries = options.maxRetries ?? SPEECH_MAX_RETRIES;
  const maxAttempts = maxRetries + 1;
  const baseDelayMs = options.baseDelayMs ?? SPEECH_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? SPEECH_MAX_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      return await operation(attempt);
    } catch (error) {
      if (isAbortError(error) || attempt >= maxAttempts || !isRetryableRealtimeSpeechError(error)) {
        throw error;
      }
      const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
      const jitter = Math.floor(exponentialDelay * Math.max(0, Math.min(random(), 1)) * 0.2);
      const nextDelayMs = Math.min(maxDelayMs, exponentialDelay + jitter);
      await options.onRetry?.({
        label: options.label,
        attempt,
        maxAttempts,
        nextDelayMs,
        reason: error instanceof Error ? error.message : String(error),
      });
      await sleep(nextDelayMs, options.signal);
    }
  }
  throw new Error('Realtime speech retry exhausted');
}

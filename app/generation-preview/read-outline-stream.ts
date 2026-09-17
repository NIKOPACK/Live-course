import type { SceneOutline } from '@/lib/types/generation';
import { createLogger } from '@/lib/logger';
import { resolveTaskEngineModeFromOutlineDoneEvent } from './vocational-mode';

const log = createLogger('OutlineStream');

interface OutlineStreamResult {
  outlines: SceneOutline[];
  languageDirective: string;
  courseTitle?: string;
  taskEngineMode: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOutline(value: unknown): value is SceneOutline {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.type === 'string' &&
    ['slide', 'quiz', 'interactive', 'pbl'].includes(value.type) &&
    typeof value.title === 'string' &&
    typeof value.description === 'string' &&
    Array.isArray(value.keyPoints) &&
    value.keyPoints.every((point) => typeof point === 'string') &&
    typeof value.order === 'number' &&
    Number.isInteger(value.order) &&
    value.order >= 0
  );
}

export async function readOutlineStream(
  response: Response,
  options: {
    signal: AbortSignal;
    onOutlines: (outlines: SceneOutline[]) => void;
    onRetry: () => void;
    messages: { failed: string; empty: string; unreadable: string };
  },
): Promise<OutlineStreamResult> {
  const { signal, messages } = options;
  signal.throwIfAborted();
  if (!response.ok) {
    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      log.warn('Outline request returned a non-JSON error response:', error);
    }
    signal.throwIfAborted();
    throw new Error(
      isRecord(data) && typeof data.error === 'string'
        ? data.error
        : `${messages.failed} (HTTP ${response.status})`,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(messages.unreadable);
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  let collected: SceneOutline[] = [];
  let directive: string | undefined;
  let title: string | undefined;
  let result: OutlineStreamResult | undefined;

  const dispatch = () => {
    if (dataLines.length === 0) return;
    const event: unknown = JSON.parse(dataLines.join('\n'));
    dataLines = [];
    if (!isRecord(event) || typeof event.type !== 'string') throw new Error(messages.failed);
    switch (event.type) {
      case 'languageDirective':
        if (typeof event.data !== 'string') throw new Error(messages.failed);
        directive = event.data;
        break;
      case 'courseTitle':
        if (typeof event.data !== 'string') throw new Error(messages.failed);
        title = event.data;
        break;
      case 'outline':
        if (!isOutline(event.data)) throw new Error(messages.failed);
        collected.push(event.data);
        options.onOutlines([...collected]);
        break;
      case 'retry':
        collected = [];
        directive = undefined;
        title = undefined;
        options.onOutlines([]);
        options.onRetry();
        break;
      case 'error':
        throw new Error(typeof event.error === 'string' ? event.error : messages.failed);
      case 'done': {
        // Only the terminal, reviewed outline set may become a persisted plan.
        const outlines = event.outlines;
        if (!Array.isArray(outlines) || outlines.length === 0) throw new Error(messages.empty);
        if (
          !outlines.every(isOutline) ||
          new Set(outlines.map((outline) => outline.id)).size !== outlines.length ||
          new Set(outlines.map((outline) => outline.order)).size !== outlines.length
        ) {
          throw new Error(messages.failed);
        }
        result = {
          outlines,
          languageDirective:
            (typeof event.languageDirective === 'string' && event.languageDirective) ||
            directive ||
            'Teach in the language that matches the user requirement.',
          courseTitle:
            (typeof event.courseTitle === 'string' && event.courseTitle) || title || undefined,
          taskEngineMode: resolveTaskEngineModeFromOutlineDoneEvent(event),
        };
        break;
      }
    }
  };
  const line = (raw: string) => {
    const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (value === '') dispatch();
    else if (value.startsWith('data:')) dataLines.push(value.slice(5).replace(/^ /, ''));
  };
  const cancelReader = async () => {
    try {
      await reader.cancel();
    } catch (error) {
      log.warn('Could not cancel the outline response reader:', error);
    }
  };
  const onAbort = () => void cancelReader();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const raw of lines) {
        line(raw);
        if (result) return result;
      }
      if (done) {
        if (buffer) line(buffer);
        dispatch();
        if (result) return result;
        throw new Error(messages.failed, {
          cause: new Error('Outline stream ended before its completion event'),
        });
      }
    }
  } catch (error) {
    if (!signal.aborted) log.warn('Outline stream failed before completion:', error);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    await cancelReader();
    reader.releaseLock();
  }
}

import { nanoid } from 'nanoid';
import type { WidgetMessageCallback } from '@/lib/action/engine';

/** Acknowledgements describe presentation only, never lesson completion. */
export function createHtmlTeacherChannel(iframe: HTMLIFrameElement) {
  const pending = new Set<{ probe: () => void; cancel: () => void }>();
  let disposed = false;

  const send: WidgetMessageCallback = (type, payload, { signal } = {}) =>
    new Promise<void>((resolve, reject) => {
      if (disposed || signal?.aborted) {
        reject(new DOMException('HTML teacher action cancelled', 'AbortError'));
        return;
      }
      const requestId = nanoid();
      let sent = false;
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        signal?.removeEventListener('abort', cancel);
        pending.delete(request);
        if (error) reject(error);
        else resolve();
      };
      const cancel = () => finish(new DOMException('HTML teacher action cancelled', 'AbortError'));
      const post = (message: Record<string, unknown>) => {
        if (!iframe.contentWindow) {
          finish(new Error('HTML classroom page is unavailable'));
          return;
        }
        iframe.contentWindow.postMessage({ ...message, __livecourseTeacher: true, requestId }, '*');
      };
      const onMessage = (event: MessageEvent) => {
        if (event.source !== iframe.contentWindow) return;
        const data = event.data;
        if (!data || data.__livecourseTeacher !== true || data.requestId !== requestId) return;
        if (data.type === 'TEACHER_READY' && !sent) {
          sent = true;
          post({ ...payload, type });
        } else if (data.type === 'TEACHER_ACTION_RESULT' && sent) {
          if (data.success === true) finish();
          else
            finish(
              new Error(typeof data.error === 'string' ? data.error : 'HTML teacher action failed'),
            );
        }
      };
      const request = {
        probe: () => {
          if (!sent) post({ type: 'TEACHER_READY_REQUEST' });
        },
        cancel,
      };
      const timeout = setTimeout(
        () => finish(new Error('HTML teacher action timed out; retry the current node')),
        10_000,
      );
      pending.add(request);
      window.addEventListener('message', onMessage);
      signal?.addEventListener('abort', cancel, { once: true });
      request.probe();
    });

  return {
    send,
    onLoad: () => {
      for (const request of pending) request.probe();
    },
    dispose: () => {
      disposed = true;
      for (const request of pending) request.cancel();
    },
  };
}

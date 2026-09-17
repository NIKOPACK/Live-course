// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useInteractiveIframePool } from '@/lib/store/interactive-iframe-pool';
import { useSceneRuntimeErrors } from '@/lib/store/scene-runtime-errors';
import { useWidgetIframeStore } from '@/lib/store/widget-iframe';
import { InteractiveIframeHost } from '@/components/scene-renderers/InteractiveIframeHost';
import { attachHtmlTeacherBridge } from '@/lib/livecourse/html/teacher-bridge';
import { sendWidgetMessage } from '@/lib/store/widget-iframe';
import { useHtmlQuestionContext } from '@/lib/livecourse/html/question-context';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US' }),
}));

let root: Root;
let container: HTMLDivElement;
const html = '<html><head></head><body>Real page</body></html>';
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useInteractiveIframePool.getState().reset();
  useSceneRuntimeErrors.getState().clearAll();
  useHtmlQuestionContext.getState().clearQuote();
  const pool = useInteractiveIframePool.getState();
  pool.mount('scene', { srcDoc: html, interactionEnabled: true });
  pool.setActive('scene');
  pool.claim('scene', 'test');
  pool.setRect('scene', { left: 0, top: 0, width: 900, height: 500 });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it('does not cover the page when an optional image resource fails to load', async () => {
  await act(async () => root.render(createElement(InteractiveIframeHost)));
  const frame = document.querySelector('iframe')!;
  await act(async () =>
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: {
          __livecourseInteractive: true,
          kind: 'runtime-error',
          errorKind: 'resource',
          message:
            'Failed to load resource: https://livecourse.nikopack.works/classroom/lesson_img_scene_1_1',
        },
      }),
    ),
  );
  expect(document.querySelector('[role=alert]')).toBeNull();
});

it('exposes sourced runtime failures and retries the same HTML without changing the scene pool', async () => {
  await act(async () => root.render(createElement(InteractiveIframeHost)));
  const frame = document.querySelector('iframe')!;
  const data = { __livecourseInteractive: true, kind: 'runtime-error', message: 'Broken script' };
  await act(async () =>
    window.dispatchEvent(new MessageEvent('message', { source: window, data })),
  );
  expect(document.querySelector('[role=alert]')).toBeNull();
  await act(async () =>
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data })),
  );
  expect(document.querySelector('[role=alert]')?.textContent).toContain('Broken script');
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  await act(async () =>
    (document.querySelector('[role=alert] button') as HTMLButtonElement).click(),
  );
  expect(document.querySelector('iframe')).not.toBe(frame);
  expect(document.querySelector('iframe')?.srcdoc).toBe(html);
  expect(useInteractiveIframePool.getState().entries.scene.srcDoc).toBe(html);
  expect(document.querySelector('[role=alert]')).toBeNull();
});

it('does not expose widget commands or keyboard interaction during replay without a teacher bridge', async () => {
  useInteractiveIframePool.getState().mount('scene', { srcDoc: html, interactionEnabled: false });
  await act(async () => root.render(createElement(InteractiveIframeHost)));
  const frame = document.querySelector('iframe')!;
  expect(frame.hasAttribute('inert')).toBe(true);
  expect(frame.tabIndex).toBe(-1);
  expect(useWidgetIframeStore.getState().getSendMessage('scene')).toBeNull();
});

it('delivers teacher visual commands during replay while blocking keyboard interaction', async () => {
  const srcDoc = attachHtmlTeacherBridge(html);
  useInteractiveIframePool.getState().mount('scene', { srcDoc, interactionEnabled: false });
  await act(async () => root.render(createElement(InteractiveIframeHost)));
  const frame = document.querySelector('iframe')!;
  expect(frame.hasAttribute('inert')).toBe(true);
  expect(frame.tabIndex).toBe(-1);
  expect(useWidgetIframeStore.getState().getSendMessage('scene')).not.toBeNull();
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation((data) => {
    const message = data as { type?: string; requestId?: string };
    if (message.type === 'TEACHER_READY_REQUEST') {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          data: {
            __livecourseTeacher: true,
            type: 'TEACHER_READY',
            requestId: message.requestId,
          },
        }),
      );
      return;
    }
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: {
          __livecourseTeacher: true,
          type: 'TEACHER_ACTION_RESULT',
          requestId: message.requestId,
          success: true,
        },
      }),
    );
  });
  await sendWidgetMessage('scene', 'REVEAL_ELEMENT', { target: '#example' });
  expect(frame.contentWindow!.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'REVEAL_ELEMENT', target: '#example' }),
    '*',
  );
});

it('uses acknowledged teacher commands and cancels pending delivery on a replay transition', async () => {
  const srcDoc = attachHtmlTeacherBridge(html);
  useInteractiveIframePool.getState().mount('scene', { srcDoc, interactionEnabled: true });
  await act(async () => root.render(createElement(InteractiveIframeHost)));
  const frame = document.querySelector('iframe')!;
  const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {});
  const execution = sendWidgetMessage('scene', 'HIGHLIGHT_ELEMENT', { target: '#concept' });
  const cancelled = expect(execution).rejects.toMatchObject({ name: 'AbortError' });
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'TEACHER_READY_REQUEST' }),
    '*',
  );
  await act(async () => {
    useInteractiveIframePool.getState().mount('scene', { srcDoc, interactionEnabled: false });
  });
  await cancelled;
  expect(useWidgetIframeStore.getState().getSendMessage('scene')).not.toBeNull();
  expect(document.querySelector('iframe')).toBe(frame);
  expect(frame.hasAttribute('inert')).toBe(true);
});

it('accepts only valid quotes from the current visible teaching iframe', async () => {
  const srcDoc = attachHtmlTeacherBridge(html);
  useInteractiveIframePool.getState().mount('scene', { srcDoc, interactionEnabled: true });
  await act(async () => root.render(createElement(InteractiveIframeHost)));
  const frame = document.querySelector('iframe')!;
  const data = {
    __livecourseTeacher: true,
    type: 'HTML_TEXT_SELECTED',
    text: 'A secant becomes a tangent.',
  };
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: window, data }));
  });
  expect(useHtmlQuestionContext.getState().quote).toBeNull();
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: { ...data, text: 'x'.repeat(501) },
      }),
    );
  });
  expect(useHtmlQuestionContext.getState().quote).toBeNull();
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data }));
  });
  expect(useHtmlQuestionContext.getState().quote).toEqual({ sceneId: 'scene', text: data.text });
  await act(async () => {
    useInteractiveIframePool.getState().setActive('another-scene');
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data }));
  });
  expect(useHtmlQuestionContext.getState().quote).toBeNull();
});

it('clears a quote on replay and ignores further selection messages', async () => {
  const srcDoc = attachHtmlTeacherBridge(html);
  useInteractiveIframePool.getState().mount('scene', { srcDoc, interactionEnabled: true });
  await act(async () => root.render(createElement(InteractiveIframeHost)));
  const frame = document.querySelector('iframe')!;
  const data = { __livecourseTeacher: true, type: 'HTML_TEXT_SELECTED', text: 'Current lesson' };
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data }));
  });
  expect(useHtmlQuestionContext.getState().quote).not.toBeNull();
  await act(async () => {
    useInteractiveIframePool.getState().mount('scene', { srcDoc, interactionEnabled: false });
  });
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data }));
  });
  expect(useHtmlQuestionContext.getState().quote).toBeNull();
});

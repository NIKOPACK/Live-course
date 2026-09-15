// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useInteractiveIframePool } from '@/lib/store/interactive-iframe-pool';
import { useSceneRuntimeErrors } from '@/lib/store/scene-runtime-errors';
import { useWidgetIframeStore } from '@/lib/store/widget-iframe';
import { InteractiveIframeHost } from '@/components/scene-renderers/InteractiveIframeHost';

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
          message: 'Failed to load resource: https://livecourse.nikopack.works/classroom/lesson_img_scene_1_1',
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

it('does not expose widget commands or keyboard interaction during replay', async () => {
  useInteractiveIframePool.getState().mount('scene', { srcDoc: html, interactionEnabled: false });
  await act(async () => root.render(createElement(InteractiveIframeHost)));
  const frame = document.querySelector('iframe')!;
  expect(frame.hasAttribute('inert')).toBe(true);
  expect(frame.tabIndex).toBe(-1);
  expect(useWidgetIframeStore.getState().getSendMessage('scene')).toBeNull();
});

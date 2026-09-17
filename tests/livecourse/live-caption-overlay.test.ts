// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LiveCaptionOverlay } from '@/components/livecourse/LiveCaptionOverlay';
import { useLiveCaptionStore } from '@/lib/store/live-caption';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: import('react').ReactNode }) => children,
  motion: {
    p: ({ children }: { children: import('react').ReactNode }) =>
      createElement('p', null, children),
  },
  useReducedMotion: () => true,
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  useLiveCaptionStore.getState().clearCaption();
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(createElement(LiveCaptionOverlay)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useLiveCaptionStore.getState().clearCaption();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('shows a new caption even when its timestamp equals an expired caption', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(100);
  await act(async () =>
    useLiveCaptionStore.getState().setCaption({ speaker: 'teacher', text: 'First' }),
  );
  await act(async () => vi.advanceTimersByTime(6000));
  expect(container.textContent).not.toContain('First');
  await act(async () =>
    useLiveCaptionStore.getState().setCaption({ speaker: 'teacher', text: 'Second' }),
  );
  expect(container.textContent).toContain('Second');
  await act(async () => vi.advanceTimersByTime(5999));
  expect(container.textContent).toContain('Second');
  await act(async () => vi.advanceTimersByTime(1));
  expect(container.textContent).not.toContain('Second');
});

it('restores an expired caption while held and starts a fresh timeout only after every hold ends', async () => {
  await act(async () =>
    useLiveCaptionStore.getState().setCaption({ speaker: 'teacher', text: 'Explanation' }),
  );
  await act(async () => vi.advanceTimersByTime(6000));
  expect(container.textContent).not.toContain('Explanation');
  await act(async () => {
    useLiveCaptionStore.getState().holdCaption();
    useLiveCaptionStore.getState().holdCaption();
  });
  expect(container.textContent).toContain('Explanation');
  await act(async () => {
    useLiveCaptionStore.getState().releaseCaption();
    vi.advanceTimersByTime(12000);
  });
  expect(container.textContent).toContain('Explanation');
  await act(async () => useLiveCaptionStore.getState().releaseCaption());
  await act(async () => vi.advanceTimersByTime(5999));
  expect(container.textContent).toContain('Explanation');
  await act(async () => vi.advanceTimersByTime(1));
  expect(container.textContent).not.toContain('Explanation');
});

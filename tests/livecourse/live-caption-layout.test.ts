// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveCaptionStore } from '@/lib/store/live-caption';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('motion/react', () => ({
  useReducedMotion: () => true,
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: {
    p: ({ children, className }: { children: ReactNode; className: string }) =>
      createElement('p', { className }, children),
  },
}));

import { LiveCaptionOverlay } from '@/components/livecourse/LiveCaptionOverlay';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  useLiveCaptionStore.getState().clearCaption();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// docs/spec/01 J3.1/J3.2: captions are a read-only display, outside the board.
describe('classroom caption layout', () => {
  it('keeps long captions readable in a bounded flow region without covering the board', async () => {
    const text = 'Explain each step without hiding the lesson. '.repeat(80);
    await act(async () => {
      root.render(createElement(LiveCaptionOverlay));
      useLiveCaptionStore.getState().setCaption({ speaker: 'teacher', text });
    });
    const region = container.querySelector('[role="log"]')!;
    expect(region.className).not.toContain('absolute');
    expect(region.className).not.toContain('pointer-events-none');
    expect(region.className).toContain('overflow-y-auto');
    expect(region.textContent).toContain(text.trim());
    expect(region.textContent).toContain('home.teacherTitle');
  });

  it('identifies the learner by text and hides stale captions without deleting the projection', async () => {
    await act(async () => {
      root.render(createElement(LiveCaptionOverlay));
      useLiveCaptionStore
        .getState()
        .setCaption({ speaker: 'student', text: 'Could you repeat that?' });
    });
    expect(container.textContent).toContain('livecourse.captionYou');
    await act(async () => vi.advanceTimersByTime(6001));
    expect(container.textContent).not.toContain('Could you repeat that?');
    expect(useLiveCaptionStore.getState().caption?.text).toBe('Could you repeat that?');
    await act(async () => {
      useLiveCaptionStore
        .getState()
        .setCaption({ speaker: 'teacher', text: 'Let us try another example.' });
    });
    expect(container.textContent).toContain('Let us try another example.');
  });
});

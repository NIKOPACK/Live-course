// @vitest-environment jsdom

import { act, createElement, forwardRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { toast } = vi.hoisted(() => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('sonner', () => ({ toast }));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/whiteboard/whiteboard-canvas', () => ({
  WhiteboardCanvas: forwardRef(function MockWhiteboardCanvas() {
    return createElement('div', { 'data-testid': 'whiteboard-canvas' });
  }),
}));

vi.mock('@/components/whiteboard/whiteboard-history', () => ({
  WhiteboardHistory: () => null,
}));

vi.mock('lucide-react', () => {
  const Icon = () => createElement('span');
  return {
    Eraser: Icon,
    History: Icon,
    Minimize2: Icon,
    PencilLine: Icon,
    RotateCcw: Icon,
  };
});

vi.mock('motion/react', () => {
  const passthrough = (tag: string) =>
    forwardRef<HTMLElement, Record<string, unknown> & { children?: ReactNode }>(
      function MotionPassthrough({ children, ...props }, ref) {
        const filtered = Object.fromEntries(
          Object.entries(props).filter(
            ([key]) => !['initial', 'animate', 'exit', 'transition', 'whileTap'].includes(key),
          ),
        );
        return createElement(tag, { ...filtered, ref } as never, children as never);
      },
    );

  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => passthrough(tag),
    },
  );

  return {
    motion,
    AnimatePresence: ({ children }: { children?: ReactNode }) =>
      createElement('fragment-placeholder', null, children),
  };
});

import { Whiteboard } from '@/components/whiteboard';
import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';

function stageWithWhiteboard() {
  return {
    id: 'whiteboard-clear-stage',
    name: 'Whiteboard stage',
    createdAt: 1,
    updatedAt: 1,
    whiteboard: [
      {
        id: 'whiteboard-1',
        viewportSize: 1000,
        viewportRatio: 16 / 9,
        elements: [
          {
            id: 'element-1',
            type: 'text',
            content: 'keep me',
            left: 0,
            top: 0,
            width: 100,
            height: 40,
            rotate: 0,
          },
        ],
        background: { type: 'solid', color: '#fff' },
        animations: [],
      },
    ],
  } as never;
}

let container: HTMLDivElement;
let root: Root;

async function render(isOpen: boolean): Promise<void> {
  await act(async () => {
    root.render(createElement(Whiteboard, { isOpen, onClose: vi.fn() }));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  toast.success.mockReset();
  toast.error.mockReset();
  useStageStore.getState().clearStore();
  useStageStore.setState({
    stage: stageWithWhiteboard(),
    scenes: [],
    currentSceneId: null,
  });
  useCanvasStore.getState().setWhiteboardClearing(false);
  useCanvasStore.getState().setWhiteboardOpen(true);
  useWhiteboardHistoryStore.getState().clearHistory();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useCanvasStore.getState().setWhiteboardClearing(false);
  useCanvasStore.getState().setWhiteboardOpen(false);
  useWhiteboardHistoryStore.getState().clearHistory();
  useStageStore.getState().clearStore();
  vi.useRealTimers();
});

describe('Whiteboard clear lifecycle', () => {
  it('resets clear state when the overlay closes and allows a later clear', async () => {
    await render(true);
    const clearButton = container.querySelector<HTMLButtonElement>(
      'button[title="whiteboard.clear"]',
    );
    expect(clearButton).not.toBeNull();

    await act(async () => {
      clearButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(useCanvasStore.getState().whiteboardClearing).toBe(true);

    await render(false);
    expect(useCanvasStore.getState().whiteboardClearing).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await Promise.resolve();
    });
    expect(useStageStore.getState().stage?.whiteboard?.[0]?.elements).toHaveLength(1);

    await render(true);
    const retryButton = container.querySelector<HTMLButtonElement>(
      'button[title="whiteboard.clear"]',
    );
    expect(retryButton).not.toBeNull();
    await act(async () => {
      retryButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
    });

    expect(useCanvasStore.getState().whiteboardClearing).toBe(false);
    expect(useStageStore.getState().stage?.whiteboard).toHaveLength(0);
    expect(toast.success).toHaveBeenCalledOnce();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActionEngine } from '@/lib/action/engine';
import type { Action } from '@/lib/types/action';

async function executeWidgetAction(action: Action) {
  vi.useFakeTimers();
  const messages: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const engine = new ActionEngine({} as never, null, (type, payload) => {
    messages.push({ type, payload });
  });

  const execution = engine.execute(action);
  await vi.advanceTimersByTimeAsync(300);
  await execution;

  return messages;
}

describe('ActionEngine widget actions', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes highlight content to the widget iframe', async () => {
    const messages = await executeWidgetAction({
      id: 'highlight-1',
      type: 'widget_highlight',
      target: '#energy-slider',
      content: 'Watch this control first.',
    });

    expect(messages).toEqual([
      {
        type: 'HIGHLIGHT_ELEMENT',
        payload: {
          target: '#energy-slider',
          content: 'Watch this control first.',
        },
      },
    ]);
  });

  it('passes setState content to the widget iframe', async () => {
    const messages = await executeWidgetAction({
      id: 'setstate-1',
      type: 'widget_setState',
      state: { energy: 82 },
      content: 'Set energy to a high value.',
    });

    expect(messages).toEqual([
      {
        type: 'SET_WIDGET_STATE',
        payload: {
          state: { energy: 82 },
          content: 'Set energy to a high value.',
        },
      },
    ]);
  });

  it('passes annotation content to the widget iframe', async () => {
    const messages = await executeWidgetAction({
      id: 'annotation-1',
      type: 'widget_annotation',
      target: '#result-card',
      content: 'This result reflects the new state.',
    });

    expect(messages).toEqual([
      {
        type: 'ANNOTATE_ELEMENT',
        payload: {
          target: '#result-card',
          content: 'This result reflects the new state.',
        },
      },
    ]);
  });

  it('passes reveal content to the widget iframe', async () => {
    const messages = await executeWidgetAction({
      id: 'reveal-1',
      type: 'widget_reveal',
      target: '#hidden-formula',
      content: 'Reveal the formula behind it.',
    });

    expect(messages).toEqual([
      {
        type: 'REVEAL_ELEMENT',
        payload: {
          target: '#hidden-formula',
          content: 'Reveal the formula behind it.',
        },
      },
    ]);
  });

  it('waits for the iframe result before finishing a visual action', async () => {
    vi.useFakeTimers();
    let acknowledge!: () => void;
    const callback = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const engine = new ActionEngine({} as never, null, callback);
    const finished = vi.fn();
    const controller = new AbortController();
    const execution = engine
      .execute(
        { id: 'focus', type: 'widget_highlight', target: '#concept' },
        { signal: controller.signal },
      )
      .then(finished);
    await vi.advanceTimersByTimeAsync(1000);
    expect(finished).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(
      'HIGHLIGHT_ELEMENT',
      { target: '#concept', content: undefined },
      { signal: controller.signal },
    );
    acknowledge();
    await vi.advanceTimersByTimeAsync(300);
    await execution;
    expect(finished).toHaveBeenCalledOnce();
  });

  it('surfaces an iframe failure instead of claiming the action completed', async () => {
    const engine = new ActionEngine({} as never, null, async () => {
      throw new Error('Teacher action target not found');
    });
    await expect(
      engine.execute({
        id: 'focus',
        type: 'widget_highlight',
        target: '#missing',
      }),
    ).rejects.toThrow('target not found');
    const disconnected = new ActionEngine({} as never);
    await expect(
      disconnected.execute({
        id: 'focus',
        type: 'widget_highlight',
        target: '#concept',
      }),
    ).rejects.toThrow('callback not set');
  });
});

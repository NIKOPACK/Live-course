// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionEngine } from '@/lib/action/engine';
import { PlaybackEngine } from '@/lib/playback/engine';
import { createAudioPlayer } from '@/lib/utils/audio-player';
import { attachHtmlTeacherBridge } from '@/lib/livecourse/html/teacher-bridge';
import { createHtmlTeacherChannel } from '@/lib/livecourse/html/teacher-channel';
import { sendWidgetMessage, useWidgetIframeStore } from '@/lib/store/widget-iframe';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';

let frame: HTMLIFrameElement;
let channel: ReturnType<typeof createHtmlTeacherChannel>;
let engine: PlaybackEngine;

beforeEach(() => {
  vi.useFakeTimers();
  frame = document.createElement('iframe');
  document.body.append(frame);
  const child = frame.contentWindow!;
  const doc = frame.contentDocument!;
  doc.body.innerHTML =
    '<section id="concept" style="outline:1px solid red">Concept</section>' +
    '<section id="example" hidden>Worked example</section>';
  Object.defineProperty(doc, 'readyState', { value: 'complete', configurable: true });
  vi.spyOn(child, 'postMessage').mockImplementation((data) => {
    child.dispatchEvent(new MessageEvent('message', { source: child.parent, data }));
  });
  vi.spyOn(child.parent, 'postMessage').mockImplementation((data) => {
    window.dispatchEvent(new MessageEvent('message', { source: child, data }));
  });
  const script = attachHtmlTeacherBridge('<html><head></head><body></body></html>').match(
    /<script data-livecourse-teacher-bridge>([\s\S]*?)<\/script>/,
  )![1];
  new Function('window', 'document', script)(child, doc);
  channel = createHtmlTeacherChannel(frame);
  useWidgetIframeStore.setState({ sendMessageByScene: {}, activeSceneId: null });
  useWidgetIframeStore.getState().registerIframe('page', channel.send);
});
afterEach(() => {
  engine?.stop();
  channel.dispose();
  frame.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function playback(actions: Action[]) {
  const speeches: { text: string; finish: () => void }[] = [];
  const speak = vi.fn(
    (text: string, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const cancel = () => reject(new DOMException('Cancelled', 'AbortError'));
        signal.addEventListener('abort', cancel, { once: true });
        speeches.push({
          text,
          finish: () => {
            signal.removeEventListener('abort', cancel);
            resolve();
          },
        });
      }),
  );
  const scene: Scene = {
    id: 'page',
    stageId: 'stage',
    order: 0,
    title: 'HTML lesson',
    type: 'interactive',
    content: { type: 'interactive', html: '<html></html>' },
    actions,
  };
  const onComplete = vi.fn();
  const onError = vi.fn();
  engine = new PlaybackEngine(
    [scene],
    new ActionEngine({} as never, null, (type, payload, options) =>
      sendWidgetMessage('page', type, payload, options),
    ),
    createAudioPlayer(),
    { speak, onComplete, onError },
  );
  return { speeches, speak, onComplete, onError };
}

describe('HTML presentation follows the real teaching cursor', () => {
  it('holds the current focus through speech and pause, then reveals the next explanation', async () => {
    const { speeches, onComplete, onError } = playback([
      { id: 'focus-1', type: 'widget_highlight', target: '#concept' },
      { id: 'speech-1', type: 'speech', text: 'Explain the concept.' },
      { id: 'reveal-2', type: 'widget_reveal', target: '#example' },
      { id: 'focus-2', type: 'widget_highlight', target: '#example' },
      { id: 'speech-2', type: 'speech', text: 'Work through the example.' },
    ]);
    const concept = frame.contentDocument!.querySelector<HTMLElement>('#concept')!;
    const example = frame.contentDocument!.querySelector<HTMLElement>('#example')!;
    engine.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(speeches.map((speech) => speech.text)).toEqual(['Explain the concept.']);
    expect(concept.style.getPropertyPriority('outline')).toBe('important');
    expect(example.hidden).toBe(true);
    engine.pause();
    await vi.advanceTimersByTimeAsync(5000);
    expect(example.hidden).toBe(true);
    engine.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(speeches).toHaveLength(2);
    speeches[1].finish();
    await vi.advanceTimersByTimeAsync(600);
    expect(example.hidden).toBe(false);
    expect(concept.style.outline).toBe('1px solid red');
    expect(example.style.getPropertyPriority('outline')).toBe('important');
    expect(speeches[2].text).toBe('Work through the example.');
    expect(onComplete).not.toHaveBeenCalled();
    speeches[2].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('preserves the failed action cursor and does not speak or complete after a missing target', async () => {
    const { speak, onComplete, onError } = playback([
      { id: 'focus', type: 'widget_highlight', target: '#missing' },
      { id: 'speech', type: 'speech', text: 'Do not speak ahead of the page.' },
    ]);
    engine.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('target not found'),
      }),
    );
    expect(engine.getMode()).toBe('paused');
    expect(engine.getSnapshot().actionIndex).toBe(0);
    expect(speak).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});

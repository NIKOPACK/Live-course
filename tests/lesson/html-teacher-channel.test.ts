// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHtmlTeacherChannel } from '@/lib/livecourse/html/teacher-channel';
import { sendWidgetMessage, useWidgetIframeStore } from '@/lib/store/widget-iframe';

let frame: HTMLIFrameElement;
let channel: ReturnType<typeof createHtmlTeacherChannel>;
beforeEach(() => {
  vi.useFakeTimers();
  frame = document.createElement('iframe');
  document.body.append(frame);
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {});
  channel = createHtmlTeacherChannel(frame);
  useWidgetIframeStore.setState({ sendMessageByScene: {}, activeSceneId: null });
});
afterEach(() => {
  channel.dispose();
  frame.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function reply(requestId: string, type: string, result = {}, source = frame.contentWindow) {
  window.dispatchEvent(
    new MessageEvent('message', {
      source,
      data: { __livecourseTeacher: true, requestId, type, ...result },
    }),
  );
}

describe('HTML teacher command delivery', () => {
  it('waits for DOM readiness, retries the probe on load, and waits for the matching result', async () => {
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    const done = vi.fn();
    const execution = Promise.resolve(
      channel.send('HIGHLIGHT_ELEMENT', { target: '#concept' }),
    ).then(done);
    const request = post.mock.calls[0][0] as { requestId: string };
    expect(post.mock.calls[0][0]).toMatchObject({ type: 'TEACHER_READY_REQUEST' });
    channel.onLoad();
    expect(post).toHaveBeenCalledTimes(2);
    reply(request.requestId, 'TEACHER_READY', {}, window);
    reply('another-action', 'TEACHER_READY');
    expect(post).toHaveBeenCalledTimes(2);
    reply(request.requestId, 'TEACHER_READY');
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'HIGHLIGHT_ELEMENT',
        target: '#concept',
        requestId: request.requestId,
      }),
      '*',
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(done).not.toHaveBeenCalled();
    reply(request.requestId, 'TEACHER_ACTION_RESULT', { success: true });
    await execution;
    expect(done).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a missing target and a page that never becomes ready', async () => {
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    const execution = channel.send('HIGHLIGHT_ELEMENT', { target: '#missing' });
    const failure = expect(execution).rejects.toThrow('target not found');
    const { requestId } = post.mock.calls[0][0] as { requestId: string };
    reply(requestId, 'TEACHER_READY');
    reply(requestId, 'TEACHER_ACTION_RESULT', { success: false, error: 'target not found' });
    await failure;
    const stalled = expect(
      channel.send('HIGHLIGHT_ELEMENT', { target: '#concept' }),
    ).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(10_000);
    await stalled;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['abort', 'dispose'] as const)('does not send stale actions after %s', async (reason) => {
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    const controller = new AbortController();
    const execution = channel.send(
      'REVEAL_ELEMENT',
      { target: '#detail' },
      {
        signal: controller.signal,
      },
    );
    const cancelled = expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    const { requestId } = post.mock.calls[0][0] as { requestId: string };
    if (reason === 'abort') controller.abort();
    else channel.dispose();
    await cancelled;
    reply(requestId, 'TEACHER_READY');
    channel.onLoad();
    expect(post).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for the exact scene registration instead of dropping the first action', async () => {
    const other = vi.fn();
    const send = vi.fn();
    const execution = sendWidgetMessage('new-scene', 'HIGHLIGHT_ELEMENT', { target: '#concept' });
    useWidgetIframeStore.getState().registerIframe('other-scene', other);
    await vi.advanceTimersByTimeAsync(1);
    expect(other).not.toHaveBeenCalled();
    useWidgetIframeStore.getState().registerIframe('new-scene', send);
    await execution;
    expect(send).toHaveBeenCalledWith(
      'HIGHLIGHT_ELEMENT',
      { target: '#concept' },
      { signal: undefined },
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels registration waits when playback is paused or leaves the scene', async () => {
    const controller = new AbortController();
    const execution = sendWidgetMessage(
      'scene',
      'REVEAL_ELEMENT',
      { target: '#detail' },
      {
        signal: controller.signal,
      },
    );
    const cancelled = expect(execution).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await cancelled;
    const send = vi.fn();
    useWidgetIframeStore.getState().registerIframe('scene', send);
    expect(send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a scene that never registers rather than advancing the lecture', async () => {
    const stalled = expect(
      sendWidgetMessage('missing-scene', 'HIGHLIGHT_ELEMENT', { target: '#concept' }),
    ).rejects.toThrow('Classroom page is not ready');
    await vi.advanceTimersByTimeAsync(10_000);
    await stalled;
    expect(vi.getTimerCount()).toBe(0);
  });
});

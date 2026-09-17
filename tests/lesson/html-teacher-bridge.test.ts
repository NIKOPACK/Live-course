// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachHtmlTeacherBridge,
  hasHtmlTeacherBridge,
} from '@/lib/livecourse/html/teacher-bridge';

function runtime() {
  document.body.innerHTML =
    '<p id="concept" style="outline:1px solid red">Concept</p><div id="detail" hidden>Worked example</div>';
  const script = attachHtmlTeacherBridge('<html><head></head><body></body></html>').match(
    /<script data-livecourse-teacher-bridge>([\s\S]*?)<\/script>/,
  )![1];
  const parent = { postMessage: vi.fn() };
  const listeners: Record<string, (event?: unknown) => void> = {};
  const timers: (() => void)[] = [];
  const doc = {
    readyState: 'complete',
    body: document.body,
    querySelector: document.querySelector.bind(document),
    createElement: document.createElement.bind(document),
    get activeElement() {
      return document.activeElement;
    },
    addEventListener: (name: string, callback: () => void) => {
      listeners[name] = callback;
    },
  };
  const win = {
    parent,
    innerWidth: 1000,
    innerHeight: 600,
    getComputedStyle: window.getComputedStyle.bind(window),
    getSelection: window.getSelection.bind(window),
    addEventListener: (name: string, callback: () => void) => {
      listeners[name] = callback;
    },
    setTimeout: vi.fn((callback: () => void) => timers.push(callback)),
    clearTimeout: vi.fn(),
  };
  new Function('window', 'document', script)(win, doc);
  const send = (data: unknown, source: unknown = parent) => listeners.message({ source, data });
  return { send, doc, listeners, timers, parent };
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

describe('HTML teacher presentation bridge', () => {
  it('keeps the current highlight through narration and restores it at the next focus', () => {
    const { send, timers } = runtime();
    const target = document.querySelector<HTMLElement>('#concept')!;
    send({ type: 'HIGHLIGHT_ELEMENT', target: '#concept' }, {});
    expect(target.style.outline).toBe('1px solid red');
    send({ type: 'HIGHLIGHT_ELEMENT', target: '#concept' });
    expect(target.style.getPropertyPriority('outline')).toBe('important');
    expect(timers).toHaveLength(0);
    send({ type: 'HIGHLIGHT_ELEMENT', target: '#detail' });
    expect(target.style.outline).toBe('1px solid red');
  });

  it('does not schedule a timeout that can clear a renewed highlight', () => {
    const { send, timers } = runtime();
    const target = document.querySelector<HTMLElement>('#concept')!;
    send({ type: 'HIGHLIGHT_ELEMENT', target: '#concept' });
    send({ type: 'HIGHLIGHT_ELEMENT', target: '#concept' });
    expect(target.style.getPropertyPriority('outline')).toBe('important');
    expect(timers).toHaveLength(0);
  });

  it('reveals hidden content and renders annotation strings as text, never markup', () => {
    const { send } = runtime();
    send({ type: 'REVEAL_ELEMENT', target: '#detail' });
    expect(document.querySelector('#detail')?.hasAttribute('hidden')).toBe(false);
    send({ type: 'ANNOTATE_ELEMENT', target: '#concept', content: '<img src=x onerror=bad()>' });
    expect(document.querySelector('[data-livecourse-teacher-note]')?.textContent).toBe(
      '<img src=x onerror=bad()>',
    );
    expect(document.querySelector('[data-livecourse-teacher-note] img')).toBeNull();
  });

  it('queues early actions until DOM readiness and surfaces missing targets', () => {
    const { send, doc, listeners } = runtime();
    doc.readyState = 'loading';
    send({ type: 'REVEAL_ELEMENT', target: '#detail' });
    expect(document.querySelector('#detail')?.hasAttribute('hidden')).toBe(true);
    listeners.DOMContentLoaded();
    expect(document.querySelector('#detail')?.hasAttribute('hidden')).toBe(false);
    doc.readyState = 'complete';
    expect(() => send({ type: 'HIGHLIGHT_ELEMENT', target: '#missing' })).toThrow(
      'target not found',
    );
    expect(() => send({ type: 'SUBMIT_QUIZ', target: '#missing' })).not.toThrow();
  });

  it('acknowledges readiness only after the DOM and reports actual action results', () => {
    const { send, doc, listeners, parent } = runtime();
    doc.readyState = 'loading';
    const envelope = { __livecourseTeacher: true, requestId: 'request-1' };
    send({ ...envelope, type: 'TEACHER_READY_REQUEST' });
    expect(parent.postMessage).not.toHaveBeenCalled();
    doc.readyState = 'complete';
    listeners.DOMContentLoaded();
    expect(parent.postMessage).toHaveBeenLastCalledWith(
      {
        ...envelope,
        type: 'TEACHER_READY',
      },
      '*',
    );
    send({ ...envelope, type: 'HIGHLIGHT_ELEMENT', target: '#concept' });
    expect(parent.postMessage).toHaveBeenLastCalledWith(
      {
        ...envelope,
        type: 'TEACHER_ACTION_RESULT',
        success: true,
      },
      '*',
    );
    send({ ...envelope, type: 'HIGHLIGHT_ELEMENT', target: '#missing' });
    expect(parent.postMessage).toHaveBeenLastCalledWith(
      {
        ...envelope,
        type: 'TEACHER_ACTION_RESULT',
        success: false,
        error: expect.stringContaining('target not found'),
      },
      '*',
    );
  });

  it('upgrades saved bridges idempotently without modifying lesson markup', () => {
    const html =
      '<html><head><script data-livecourse-teacher-bridge>old()</script></head>' +
      '<body><section id="concept">Lesson</section><script>lesson()</script></body></html>';
    const upgraded = attachHtmlTeacherBridge(html);
    expect(hasHtmlTeacherBridge(upgraded)).toBe(true);
    expect(upgraded.match(/<script data-livecourse-teacher-bridge>/g)).toHaveLength(1);
    expect(upgraded).not.toContain('old()');
    expect(upgraded).toContain('<section id="concept">Lesson</section><script>lesson()</script>');
    expect(attachHtmlTeacherBridge(upgraded)).toBe(upgraded);
  });

  it('projects a text selection as a bounded draft quote, not a teacher action', () => {
    const { listeners, timers, parent } = runtime();
    const target = document.querySelector('#concept')!;
    target.textContent = `  ${'Example '.repeat(100)}  `;
    const range = document.createRange();
    range.selectNodeContents(target);
    window.getSelection()!.addRange(range);
    listeners.selectionchange();
    expect(parent.postMessage).not.toHaveBeenCalled();
    timers.at(-1)!();
    expect(parent.postMessage).toHaveBeenCalledOnce();
    const message = parent.postMessage.mock.calls[0][0];
    expect(message).toEqual({
      __livecourseTeacher: true,
      type: 'HTML_TEXT_SELECTED',
      text: expect.any(String),
    });
    expect(message.text.length).toBe(500);
    expect(message.text).toMatch(/^Example /);
  });

  it('ignores collapsed selections and editable drafts', () => {
    const { listeners, timers, parent } = runtime();
    listeners.selectionchange();
    timers.at(-1)!();
    expect(parent.postMessage).not.toHaveBeenCalled();
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    editable.textContent = 'Do not quote my draft.';
    document.body.append(editable);
    const range = document.createRange();
    range.selectNodeContents(editable);
    window.getSelection()!.addRange(range);
    listeners.selectionchange();
    timers.at(-1)!();
    expect(parent.postMessage).not.toHaveBeenCalled();
    range.selectNodeContents(document.body);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    listeners.selectionchange();
    timers.at(-1)!();
    expect(parent.postMessage).not.toHaveBeenCalled();
    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    range.selectNodeContents(document.querySelector('#concept')!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    textarea.focus();
    listeners.selectionchange();
    timers.at(-1)!();
    expect(parent.postMessage).not.toHaveBeenCalled();
  });
});

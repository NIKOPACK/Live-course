// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachHtmlTeacherBridge } from '@/lib/livecourse/html/teacher-bridge';

function runtime() {
  document.body.innerHTML =
    '<p id="concept" style="outline:1px solid red">Concept</p><div id="detail" hidden>Worked example</div>';
  const script = attachHtmlTeacherBridge('<html><head></head><body></body></html>').match(
    /<script data-livecourse-teacher-bridge>([\s\S]*?)<\/script>/,
  )![1];
  const parent = {};
  const listeners: Record<string, (event?: unknown) => void> = {};
  const timers: (() => void)[] = [];
  const doc = {
    readyState: 'complete',
    body: document.body,
    querySelector: document.querySelector.bind(document),
    createElement: document.createElement.bind(document),
    addEventListener: (name: string, callback: () => void) => {
      listeners[name] = callback;
    },
  };
  const win = {
    parent,
    innerWidth: 1000,
    innerHeight: 600,
    getComputedStyle: window.getComputedStyle.bind(window),
    addEventListener: (name: string, callback: () => void) => {
      listeners[name] = callback;
    },
    setTimeout: vi.fn((callback: () => void) => timers.push(callback)),
  };
  new Function('window', 'document', script)(win, doc);
  const send = (data: unknown, source = parent) => listeners.message({ source, data });
  return { send, doc, listeners, timers };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('HTML teacher presentation bridge', () => {
  it('highlights real elements and restores the original styling', () => {
    const { send, timers } = runtime();
    const target = document.querySelector<HTMLElement>('#concept')!;
    send({ type: 'HIGHLIGHT_ELEMENT', target: '#concept' }, {});
    expect(target.style.outline).toBe('1px solid red');
    send({ type: 'HIGHLIGHT_ELEMENT', target: '#concept' });
    expect(target.style.getPropertyPriority('outline')).toBe('important');
    timers[0]();
    expect(target.style.outline).toBe('1px solid red');
  });

  it('does not let an older timeout clear a renewed highlight', () => {
    const { send, timers } = runtime();
    const target = document.querySelector<HTMLElement>('#concept')!;
    send({ type: 'HIGHLIGHT_ELEMENT', target: '#concept' });
    send({ type: 'HIGHLIGHT_ELEMENT', target: '#concept' });
    timers[0]();
    expect(target.style.getPropertyPriority('outline')).toBe('important');
    timers[1]();
    expect(target.style.outline).toBe('1px solid red');
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
});

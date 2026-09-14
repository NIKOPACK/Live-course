// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('next/dynamic', () => ({
  default: () =>
    function FakeTeacherAvatar({ onStatusChange }: { onStatusChange: (status: 'ready') => void }) {
      useEffect(() => onStatusChange('ready'), [onStatusChange]);
      return createElement('div', { 'data-testid': 'home-live-teacher' });
    },
}));

import { HomeTeacherScene } from '@/components/livecourse/HomeTeacherScene';

let container: HTMLDivElement;
let root: Root | undefined;
let desktop = false;
const listeners = new Set<() => void>();
const idleCallbacks: (() => void)[] = [];
const media = {
  get matches() {
    return desktop;
  },
  addEventListener: vi.fn((_event: string, listener: () => void) => listeners.add(listener)),
  removeEventListener: vi.fn((_event: string, listener: () => void) => listeners.delete(listener)),
};
const requestIdle = vi.fn((callback: () => void) => {
  idleCallbacks.push(callback);
  return idleCallbacks.length;
});
const cancelIdle = vi.fn();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  desktop = false;
  listeners.clear();
  idleCallbacks.length = 0;
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => media),
  );
  vi.stubGlobal('requestIdleCallback', requestIdle);
  vi.stubGlobal('cancelIdleCallback', cancelIdle);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderScene() {
  await act(async () => root!.render(createElement(HomeTeacherScene)));
}

async function resize(wide: boolean) {
  await act(async () => {
    desktop = wide;
    for (const listener of listeners) listener();
  });
}

describe('homepage teacher scene', () => {
  it('keeps a lightweight teacher on narrow screens and explains when lesson content is prepared', async () => {
    await renderScene();
    expect(container.querySelectorAll('[data-testid="teacher-poster"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="home-live-teacher"]')).toBeNull();
    expect(requestIdle).not.toHaveBeenCalled();
    expect(window.matchMedia).toHaveBeenCalledWith(
      '(min-width: 1024px) and (prefers-reduced-motion: no-preference)',
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe('home.teacherTitle');
    expect(container.querySelector('figcaption')?.textContent).toBe('home.boardTitle');
    expect(container.querySelector('figure')?.textContent).toContain('home.boardNote');
    expect(container.querySelector('figure button')).toBeNull();
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the poster before requesting the desktop avatar during idle time', async () => {
    desktop = true;
    await renderScene();
    expect(requestIdle).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="teacher-poster"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('home.teacherTitle');

    await act(async () => idleCallbacks[0]());
    expect(container.querySelector('[data-testid="home-live-teacher"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('home.avatarGreeting');
  });

  it('cancels pending loading and removes a mounted avatar when the viewport becomes narrow', async () => {
    desktop = true;
    await renderScene();
    await resize(false);
    expect(cancelIdle).toHaveBeenCalledWith(1);
    await act(async () => idleCallbacks[0]());
    expect(container.querySelector('[data-testid="home-live-teacher"]')).toBeNull();

    await resize(true);
    expect(requestIdle).toHaveBeenCalledTimes(2);
    await act(async () => idleCallbacks[1]());
    expect(container.querySelector('[data-testid="home-live-teacher"]')).not.toBeNull();

    await resize(false);
    expect(container.querySelector('[data-testid="home-live-teacher"]')).toBeNull();
    expect(container.querySelector('[data-testid="teacher-poster"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('home.teacherTitle');
  });

  it('cleans up a pending upgrade and viewport listener when leaving the homepage', async () => {
    desktop = true;
    await renderScene();
    await act(async () => root!.unmount());
    root = undefined;
    expect(cancelIdle).toHaveBeenCalledWith(1);
    expect(media.removeEventListener).toHaveBeenCalledOnce();
    expect(listeners.size).toBe(0);
    await act(async () => idleCallbacks[0]());
    expect(container.childElementCount).toBe(0);
  });

  it('defers desktop loading with a timer when idle callbacks are unavailable', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);
    vi.stubGlobal('cancelIdleCallback', undefined);
    desktop = true;
    await renderScene();
    await act(async () => vi.advanceTimersByTime(1499));
    expect(container.querySelector('[data-testid="home-live-teacher"]')).toBeNull();
    await act(async () => vi.advanceTimersByTime(1));
    expect(container.querySelector('[data-testid="home-live-teacher"]')).not.toBeNull();
  });
});

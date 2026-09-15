// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lastAvatar: { current: FakeAiriVrmAvatar | null } = { current: null };
const settings = vi.hoisted(() => ({
  enabled: true,
  modelUrl: '',
  idleAnimationUrl: '',
  trackingMode: 'none',
  interactionsEnabled: true,
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

class FakeAiriVrmAvatar extends HTMLElement {
  modelSrc = '';
  idleAnimationSrc = '';
  status: 'idle' | 'loading' | 'ready' | 'error' | 'unsupported' = 'idle';
  trackingMode = 'none';
  interactionsEnabled = true;

  constructor() {
    super();
    lastAvatar.current = this;
  }

  setExpression(): void {}
  setLookAt(): void {}
  connectAudio(): void {}
  disconnectAudio(): void {}

  emit(status: FakeAiriVrmAvatar['status']): void {
    this.status = status;
    this.dispatchEvent(new CustomEvent('airi-vrm-status', { detail: { status } }));
  }
}

vi.mock('@/lib/store/avatar-settings', () => ({
  useAvatarSettingsStore: (select: (state: Record<string, unknown>) => unknown) => select(settings),
}));

vi.mock('@/lib/livecourse/realtime/client/audio-bridge', () => ({
  getActiveRealtimeAudioBridge: () => null,
  getActiveLipSyncAudioNode: () => null,
  subscribeRealtimeAudioBridge: () => () => undefined,
}));

vi.mock('@/lib/livecourse/avatar/airi-vrm-element', () => ({
  ensureAiriVrmAvatarElement: () => {
    if (typeof customElements === 'undefined') return;
    if (!customElements.get('airi-vrm-avatar')) {
      customElements.define('airi-vrm-avatar', FakeAiriVrmAvatar);
    }
  },
}));

import { TeacherAvatar } from '@/components/livecourse/TeacherAvatar';

let container: HTMLDivElement;
let root: Root | undefined;

function canvasLayer(): HTMLElement {
  const canvas = container.querySelector('[data-testid="teacher-canvas"]');
  if (!(canvas instanceof HTMLElement)) {
    throw new Error('3D mount layer missing');
  }
  return canvas;
}

function poster(): HTMLImageElement {
  const image = container.querySelector('[data-testid="teacher-poster"]');
  if (!(image instanceof HTMLImageElement)) {
    throw new Error('poster missing');
  }
  return image;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  lastAvatar.current = null;
  settings.enabled = true;
  settings.modelUrl = '';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
});

describe('TeacherAvatar reveal', () => {
  it('uncovers the 3D teacher as soon as the model reports ready, without a hold delay', async () => {
    await act(async () => {
      root!.render(
        createElement(TeacherAvatar, {
          mode: 'idle',
          expression: 'neutral',
          lookAt: 'camera',
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(lastAvatar.current).not.toBeNull();
    expect(canvasLayer().className).toContain('opacity-0');
    expect(poster().className).toContain('opacity-100');

    await act(async () => {
      lastAvatar.current!.emit('ready');
    });

    expect(
      container.querySelector('[data-avatar-status]')?.getAttribute('data-avatar-status'),
    ).toBe('ready');
    expect(canvasLayer().className).toContain('opacity-100');
    expect(canvasLayer().className).not.toContain('opacity-0');
    expect(poster().className).toContain('opacity-0');
    expect(container.querySelector('[data-testid="teacher-stage-bg"]')).not.toBeNull();
    expect(container.querySelector('[data-avatar-status]')?.className).toContain('lc-avatar');
    expect(poster().getAttribute('src')).toBe('/avatars/teacher-avatar-poster.png');
    expect(poster().getAttribute('src')).not.toContain('/_next/image');
  });

  it('keeps the same portrait on failure and lets the learner retry only the avatar', async () => {
    await act(async () =>
      root!.render(
        createElement(TeacherAvatar, {
          mode: 'idle',
          expression: 'neutral',
          lookAt: 'camera',
        }),
      ),
    );
    const first = lastAvatar.current!;
    await act(async () => first.emit('error'));
    expect(poster().className).toContain('opacity-100');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'home.avatarUnavailable',
    );
    const retry = container.querySelector('button')!;
    expect(retry.textContent).toBe('home.avatarRetry');
    await act(async () => retry.click());
    expect(first.isConnected).toBe(false);
    expect(lastAvatar.current).not.toBe(first);
    await act(async () => lastAvatar.current!.emit('ready'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(poster().className).toContain('opacity-0');
  });

  it('does not introduce a different person while a custom model is loading', async () => {
    settings.modelUrl = '/custom-teacher.vrm';
    await act(async () =>
      root!.render(
        createElement(TeacherAvatar, {
          mode: 'idle',
          expression: 'neutral',
          lookAt: 'camera',
        }),
      ),
    );
    expect(lastAvatar.current?.modelSrc).toBe('/custom-teacher.vrm');
    expect(container.querySelector('[data-testid="teacher-poster"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'home.avatarPreparing',
    );
  });

  it('does not claim the disabled 3D model is still loading', async () => {
    settings.enabled = false;
    await act(async () =>
      root!.render(
        createElement(TeacherAvatar, {
          mode: 'idle',
          expression: 'neutral',
          lookAt: 'camera',
        }),
      ),
    );
    expect(lastAvatar.current?.modelSrc).toBe('');
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(poster().className).toContain('opacity-100');
  });
});

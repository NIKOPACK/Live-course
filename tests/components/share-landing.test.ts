// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchShareMetadata: vi.fn(),
  readShareRedeemRegistration: vi.fn(),
  redeemCourseShare: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  useParams: () => ({ token: 'sharetoken11111111' }),
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.count != null ? `${key}:${options.count}` : key,
  }),
}));
vi.mock('@/lib/livecourse/share', () => ({
  fetchShareMetadata: mocks.fetchShareMetadata,
  readShareRedeemRegistration: mocks.readShareRedeemRegistration,
  redeemCourseShare: mocks.redeemCourseShare,
  CourseShareRedeemError: class CourseShareRedeemError extends Error {
    constructor(
      message: string,
      readonly status?: number,
    ) {
      super(message);
    }
  },
}));
vi.mock('@/components/livecourse/GameLoader', () => ({
  GameLoader: ({ label }: { label: string }) => createElement('div', { 'data-testid': 'loader' }, label),
}));

import ShareLandingPage from '@/app/share/[token]/page';

describe('share landing page', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    mocks.fetchShareMetadata.mockResolvedValue({
      token: 'sharetoken11111111',
      title: 'Shared Fourier',
      sceneCount: 3,
      createdAt: '2026-09-18T00:00:00.000Z',
      hasCover: false,
    });
    mocks.readShareRedeemRegistration.mockResolvedValue(null);
    mocks.redeemCourseShare.mockResolvedValue({
      stageId: 'stage-copy',
      courseId: 'course-copy',
      lessonId: 'lesson-copy',
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it('shows title, cover placeholder, scene count, and join', async () => {
    await act(async () => {
      root.render(createElement(ShareLandingPage));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Shared Fourier');
    expect(container.querySelector('[data-testid="share-landing-cover"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="share-landing-scene-count"]')?.textContent).toContain(
      '3',
    );
    expect(container.querySelector('[data-testid="share-landing-join"]')).not.toBeNull();
  });

  it('ignores a second join click while the first redeem is in flight', async () => {
    let finish: ((value: { stageId: string; courseId: string; lessonId: string }) => void) | undefined;
    mocks.redeemCourseShare.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => {
      root.render(createElement(ShareLandingPage));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    const join = container.querySelector<HTMLButtonElement>('[data-testid="share-landing-join"]')!;
    await act(async () => {
      join.click();
      join.click();
      await Promise.resolve();
    });
    expect(mocks.redeemCourseShare).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish?.({ stageId: 'stage-copy', courseId: 'course-copy', lessonId: 'lesson-copy' });
      await Promise.resolve();
    });
  });
});

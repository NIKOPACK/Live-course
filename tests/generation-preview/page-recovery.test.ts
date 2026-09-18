// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useStageStore } from '@/lib/store/stage';
import GenerationPreviewPage from '@/app/generation-preview/page';
import type { GenerationSessionState } from '@/app/generation-preview/types';
import type { SceneOutline } from '@/lib/types/generation';

const mocks = vi.hoisted(() => ({
  stop: vi.fn(),
  generateRemaining: vi.fn(),
  retrySingleOutline: vi.fn(),
  push: vi.fn(),
  loadMemory: vi.fn(),
  persistIntake: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/hooks/use-scene-generator', () => ({
  useSceneGenerator: () => ({
    stop: mocks.stop,
    generateRemaining: mocks.generateRemaining,
    retrySingleOutline: mocks.retrySingleOutline,
  }),
}));
vi.mock('@/lib/utils/model-config', () => ({ getCurrentModelConfig: () => ({}) }));
vi.mock('@/lib/utils/image-storage', () => ({
  cleanupOldImages: async () => undefined,
  loadImageMapping: async () => ({}),
}));
vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: async () => undefined,
  saveStageDataIncremental: async () => undefined,
}));
vi.mock('@/lib/runtime/learner-key', () => ({ getLearnerKey: async () => 'learner-1' }));
vi.mock('@/lib/runtime/store', () => ({ getRuntimeStore: () => ({}) }));
vi.mock('@/lib/livecourse/memory', () => ({
  loadNewCourseMemoryContext: mocks.loadMemory,
  persistGenerationCourseIntake: mocks.persistIntake,
  buildGenerationCourseIntake: () => ({}),
}));
vi.mock('@/components/livecourse/GameLoader', () => ({
  GameLoader: () => createElement('span', null, 'Loading'),
}));
vi.mock('@/app/generation-preview/components/segment-list', () => ({
  SegmentList: ({ segments }: { segments: { title: string }[] }) =>
    createElement(
      'div',
      { 'data-testid': 'segments' },
      segments.map((segment) => segment.title).join(),
    ),
}));
vi.mock('@/app/generation-preview/components/lesson-plan-panel', () => ({
  LessonPlanPanel: () => null,
}));

const outline: SceneOutline = {
  id: 'outline-new',
  type: 'interactive',
  order: 0,
  title: 'New concept',
  description: 'Explain the new concept',
  keyPoints: ['Concept'],
};
const session: GenerationSessionState = {
  sessionId: 'new',
  stageId: 'stage-new',
  courseId: 'course-new',
  lessonId: 'lesson-new',
  currentStep: 'generating',
  previewPhase: 'preparing',
  confirmationDone: true,
  requirements: { requirement: 'Explain the new concept', webSearch: false },
  pdfText: '',
};
let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn<typeof fetch>();
const savedSession = () =>
  JSON.parse(sessionStorage.getItem('generationSession')!) as GenerationSessionState;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock
    .mockReset()
    .mockResolvedValue(
      new Response(JSON.stringify({ error: 'No model request expected' }), { status: 400 }),
    );
  mocks.loadMemory.mockReset().mockResolvedValue({ teacherContext: { text: '' } });
  mocks.persistIntake.mockReset().mockResolvedValue(undefined);
  useStageStore.getState().clearStore();
  sessionStorage.clear();
  sessionStorage.setItem('generationSession', JSON.stringify(session));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useStageStore.getState().clearStore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(createElement(GenerationPreviewPage)));
}

it('does not mark a new generation complete or expose entry using the previous classroom', async () => {
  useStageStore.getState().setStage({ id: 'stage-old', name: 'Old', createdAt: 1, updatedAt: 1 });
  useStageStore.getState().setOutlines([{ ...outline, id: 'old', title: 'Old classroom' }]);
  useStageStore.getState().addScene({
    id: 'scene-old',
    outlineId: 'old',
    stageId: 'stage-old',
    type: 'interactive',
    title: 'Old classroom',
    order: 0,
    content: { type: 'interactive', html: '<main>Old</main>' },
  });
  mocks.loadMemory.mockImplementation(() => new Promise(() => undefined));
  await render();
  expect(savedSession().currentStep).toBe('generating');
  expect(container.querySelector('[data-testid="enter-classroom"]')).toBeNull();
  expect(container.textContent).not.toContain('Old classroom');
});

it('does not persist a truncated outline stream or start lesson planning from partial results', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(`data: ${JSON.stringify({ type: 'outline', data: outline })}\n\n`),
  );
  await render();
  expect(savedSession().sceneOutlines).toBeUndefined();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="segments"]')).toBeNull();
  expect(container.textContent).not.toContain(outline.title);
});

it('keeps streamed drafts and retries in one preparation surface until the outline is complete', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  fetchMock
    .mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
      ),
    )
    .mockImplementationOnce(() => new Promise(() => undefined));
  await render();
  const surface = container.querySelector('[data-testid="preparation-surface"]');
  const skeleton = container.querySelector('[data-testid="outline-stream-preview"]');
  const header = container.querySelector('header');
  const enqueue = async (event: unknown) => {
    await act(async () => {
      stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    });
  };
  await enqueue({ type: 'outline', data: outline });
  expect(container.querySelector('[data-testid="segments"]')).toBeNull();
  expect(skeleton?.textContent).toContain(outline.title);
  expect(container.querySelector('[data-testid="preparation-steps"]')).not.toBeNull();
  await enqueue({ type: 'retry' });
  expect(container.querySelector('[data-testid="preparation-surface"]')).toBe(surface);
  expect(container.querySelector('[data-testid="outline-stream-preview"]')).toBe(skeleton);
  expect(skeleton?.textContent).not.toContain(outline.title);
  expect(container.textContent).toContain('generation.outlineRetrying');
  await enqueue({ type: 'outline', data: outline });
  expect(container.textContent).not.toContain('generation.outlineRetrying');
  await enqueue({ type: 'done', outlines: [outline] });
  expect(container.querySelector('[data-testid="preparation-surface"]')).toBe(surface);
  expect(container.querySelector('header')).toBe(header);
  expect(container.querySelector('[data-testid="outline-stream-preview"]')).toBeNull();
  expect(container.querySelector('[data-testid="segments"]')?.textContent).toContain(outline.title);
  expect(container.querySelector('[aria-current="step"]')?.getAttribute('data-step')).toBe(
    'lesson-plan',
  );
  expect(container.querySelector('[data-testid="enter-classroom"]')).toBeNull();
  expect(savedSession().sceneOutlines).toEqual([outline]);
});

it('surfaces completed-session hydration failure and supports retry in the preview', async () => {
  sessionStorage.setItem(
    'generationSession',
    JSON.stringify({ ...session, currentStep: 'complete', sceneOutlines: [outline] }),
  );
  vi.spyOn(useStageStore.getState(), 'loadFromStorage').mockRejectedValue(
    new Error('Storage offline'),
  );
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'generation.sessionLoadFailed',
  );
  expect(
    [...container.querySelectorAll('button')].some(
      (button) => button.textContent === 'clarify.retry',
    ),
  ).toBe(true);
});

it('retry after an interrupted stream persists only the next completed outline set', async () => {
  fetchMock
    .mockResolvedValueOnce(
      new Response(`data: ${JSON.stringify({ type: 'outline', data: outline })}\n\n`),
    )
    .mockResolvedValueOnce(
      new Response(`data: ${JSON.stringify({ type: 'done', outlines: [outline] })}\n\n`),
    );
  await render();
  const retry = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'clarify.retry',
  );
  expect(retry).toBeDefined();
  await act(async () => retry!.click());
  expect(savedSession().sceneOutlines).toEqual([outline]);
  expect(savedSession().courseId).toBe(session.courseId);
  expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
    '/api/generate/scene-outlines-stream',
    '/api/generate/scene-outlines-stream',
    '/api/generate/lesson-plan',
  ]);
});

it('resumes missing durable scenes even when the session envelope says complete', async () => {
  sessionStorage.setItem(
    'generationSession',
    JSON.stringify({ ...session, currentStep: 'complete', sceneOutlines: [outline] }),
  );
  vi.spyOn(useStageStore.getState(), 'loadFromStorage').mockImplementation(async () => {
    useStageStore.getState().setStage({
      id: 'stage-new',
      name: 'New',
      createdAt: 1,
      updatedAt: 1,
    });
    useStageStore.getState().setOutlines([outline]);
    useStageStore.setState({ generationComplete: true });
  });
  mocks.loadMemory.mockImplementation(() => new Promise(() => undefined));
  await render();
  expect(savedSession().currentStep).toBe('generating');
  expect(useStageStore.getState().generationComplete).toBe(false);
  expect(container.querySelector('[data-testid="enter-classroom"]')).toBeNull();
});

it('does not restart generation or write intake after leaving during an asynchronous memory load', async () => {
  let resolveMemory!: (value: unknown) => void;
  mocks.loadMemory.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveMemory = resolve;
      }),
  );
  await render();
  const back = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'generation.backToHome',
  );
  expect(back).toBeDefined();
  await act(async () => {
    back!.click();
    resolveMemory({ teacherContext: { text: '' } });
  });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(mocks.persistIntake).not.toHaveBeenCalled();
  expect(savedSession().currentStep).toBe('generating');
});

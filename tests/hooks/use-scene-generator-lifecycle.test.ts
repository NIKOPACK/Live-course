// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSceneGenerator } from '@/lib/hooks/use-scene-generator';
import { useStageStore } from '@/lib/store/stage';
import { buildLessonPlanSkeleton } from '@/lib/livecourse/lesson/skeleton';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';

vi.mock('@/lib/utils/model-config', () => ({ getCurrentModelConfig: () => ({}) }));
const settings = vi.hoisted(() => ({ parallelSceneConcurrency: 0 }));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: () => settings },
}));
vi.mock('@/lib/media/media-orchestrator', () => ({
  generateMediaForOutlines: async () => undefined,
  reconcileCompletedMediaForScene: (scene: Scene, stage: unknown) => ({ scene, stage }),
}));
vi.mock('@/lib/livecourse/lesson/course-cover-runtime', () => ({
  generateAndPersistCourseCover: async () => undefined,
}));
vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: async () => undefined,
  saveStageDataIncremental: async () => undefined,
}));

const outlines: SceneOutline[] = [0, 1, 2].map((order) => ({
  id: `outline-${order}`,
  title: `Segment ${order}`,
  type: 'interactive',
  order,
  description: 'Explain a concept',
  keyPoints: ['A concept'],
}));
const params = { stageInfo: { name: 'Course' } };
const failed = () =>
  new Response(JSON.stringify({ success: false, error: 'Invalid provider credentials' }), {
    status: 401,
  });
function scene(order: number): Scene {
  return {
    id: `scene-${order}`,
    outlineId: outlines[order].id,
    stageId: 'stage-1',
    type: 'interactive',
    title: `Segment ${order}`,
    order,
    content: { type: 'interactive', html: '<main id="concept">Concept</main>' },
    actions: [{ id: `speech-${order}`, type: 'speech', text: `Speech ${order}` }],
  };
}
function success(url: string, init: RequestInit) {
  const body = JSON.parse(String(init.body));
  return new Response(
    JSON.stringify(
      url.endsWith('scene-content')
        ? { success: true, content: { html: '<main id="concept">Concept</main>' } }
        : { success: true, scene: scene(body.outline.order) },
    ),
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: Root;
let container: HTMLDivElement;
let generator: ReturnType<typeof useSceneGenerator>;
const fetchMock = vi.fn<typeof fetch>();
const onSceneFailed = vi.fn();
const onComplete = vi.fn();
function Harness() {
  const value = useSceneGenerator({ onSceneFailed, onComplete });
  useEffect(() => {
    generator = value;
  }, [value]);
  return null;
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock
    .mockReset()
    .mockImplementation((url, init) => Promise.resolve(success(String(url), init!)));
  onSceneFailed.mockClear();
  onComplete.mockClear();
  settings.parallelSceneConcurrency = 0;
  useStageStore.getState().setStage({
    id: 'stage-1',
    name: 'Course',
    createdAt: 1,
    updatedAt: 1,
  });
  useStageStore.getState().setOutlines(outlines);
  useStageStore.getState().setLessonPlan({
    ...buildLessonPlanSkeleton({
      stageId: 'stage-1',
      courseId: 'course-1',
      requirement: 'Explain a concept',
      outlines,
    }),
    presentation: { mode: 'html', visualStyle: 'Paper and teal diagrams.' },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Harness)));
});
afterEach(async () => {
  generator.stop();
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function failFirstSegment() {
  fetchMock.mockResolvedValueOnce(failed());
  await generator.generateRemaining(params);
  expect(useStageStore.getState().failedOutlines.map((outline) => outline.id)).toEqual([
    'outline-0',
  ]);
}

it('clears active markers after a batch failure instead of leaving waiting segments generating', async () => {
  await failFirstSegment();
  expect(useStageStore.getState().generationStatus).toBe('paused');
  expect(useStageStore.getState().generatingOutlines).toEqual([]);
  expect(useStageStore.getState().currentGeneratingOrder).toBe(-1);
});

it('a repeated single-segment failure returns to paused and reports its cause', async () => {
  await failFirstSegment();
  fetchMock.mockResolvedValueOnce(failed());
  await generator.retrySingleOutline('outline-0');
  expect(useStageStore.getState().generationStatus).toBe('paused');
  expect(useStageStore.getState().generatingOutlines).toEqual([]);
  expect(onSceneFailed).toHaveBeenLastCalledWith(outlines[0], 'Invalid provider credentials');
  expect(onSceneFailed).toHaveBeenCalledTimes(2);
  expect(generator.isGenerating()).toBe(false);
});

it('successful retry awaits the remaining segments and reaches a clean completed state', async () => {
  await failFirstSegment();
  await generator.retrySingleOutline('outline-0');
  expect(useStageStore.getState().scenes.map((scene) => scene.order)).toEqual([0, 1, 2]);
  expect(useStageStore.getState().failedOutlines).toEqual([]);
  expect(useStageStore.getState().generationComplete).toBe(true);
  expect(useStageStore.getState().generationStatus).toBe('completed');
  expect(onComplete).toHaveBeenCalledOnce();
});

it('does not retry other failed segments or replace successful segments when resuming', async () => {
  await failFirstSegment();
  useStageStore.getState().addFailedOutline(outlines[1]);
  useStageStore.getState().addScene(scene(2));
  const savedScene = useStageStore.getState().scenes[0];
  fetchMock.mockClear();
  await generator.retrySingleOutline('outline-0');
  expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).outline.id)).toEqual(
    ['outline-0', 'outline-0'],
  );
  expect(useStageStore.getState().failedOutlines).toEqual([outlines[1]]);
  expect(useStageStore.getState().scenes.find((scene) => scene.order === 2)).toBe(savedScene);
  expect(useStageStore.getState().generationComplete).toBe(false);
});

it('threads only earlier speech into a gap retry, never a later completed segment', async () => {
  useStageStore.getState().addScene(scene(0));
  fetchMock.mockResolvedValueOnce(failed());
  await generator.generateRemaining(params);
  useStageStore.getState().addScene(scene(2));
  fetchMock.mockClear();
  await generator.retrySingleOutline('outline-1');
  const actionRequest = fetchMock.mock.calls.find(([url]) => String(url).endsWith('scene-actions'));
  expect(JSON.parse(String(actionRequest?.[1]?.body)).previousSpeeches).toEqual(['Speech 0']);
});

it('stop aborts a retry request and prevents late results from touching another stage', async () => {
  await failFirstSegment();
  const response = deferred<Response>();
  fetchMock.mockImplementationOnce(() => response.promise);
  const retry = generator.retrySingleOutline('outline-0');
  const signal = fetchMock.mock.lastCall?.[1]?.signal;
  expect(generator.isGenerating()).toBe(true);
  generator.stop();
  expect(signal?.aborted).toBe(true);
  useStageStore.getState().setStage({ id: 'stage-2', name: 'Other', createdAt: 2, updatedAt: 2 });
  useStageStore.getState().setGenerationStatus('generating');
  response.resolve(failed());
  await retry;
  expect(useStageStore.getState().stage?.id).toBe('stage-2');
  expect(useStageStore.getState().failedOutlines).toEqual([]);
  expect(useStageStore.getState().generationStatus).toBe('generating');
});

it('a stale batch does not pause a newly selected course', async () => {
  const response = deferred<Response>();
  fetchMock.mockImplementationOnce(() => response.promise);
  const run = generator.generateRemaining(params);
  useStageStore.getState().setStage({ id: 'stage-2', name: 'Other', createdAt: 2, updatedAt: 2 });
  useStageStore.getState().setGenerationStatus('generating');
  response.resolve(success('scene-content', { body: JSON.stringify({ outline: outlines[0] }) }));
  await run;
  expect(useStageStore.getState().generationStatus).toBe('generating');
  expect(useStageStore.getState().scenes).toEqual([]);
});

it('serializes duplicate retry clicks so a segment is materialized only once', async () => {
  await failFirstSegment();
  const response = deferred<Response>();
  fetchMock.mockImplementationOnce(() => response.promise);
  const first = generator.retrySingleOutline('outline-0');
  await generator.retrySingleOutline('outline-0');
  expect(generator.isGenerating()).toBe(true);
  response.resolve(success('scene-content', { body: JSON.stringify({ outline: outlines[0] }) }));
  await first;
  expect(useStageStore.getState().scenes.filter((scene) => scene.order === 0)).toHaveLength(1);
});

it('keeps parallel successes intact when a failed segment is retried', async () => {
  settings.parallelSceneConcurrency = 2;
  fetchMock.mockResolvedValueOnce(failed());
  await generator.generateRemaining(params);
  const completed = useStageStore.getState().scenes;
  expect(completed.map((scene) => scene.order)).toEqual([1, 2]);
  expect(useStageStore.getState().generationStatus).toBe('paused');
  fetchMock.mockClear();
  await generator.retrySingleOutline('outline-0');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(useStageStore.getState().scenes.slice(0, 2)).toEqual(completed);
  expect(useStageStore.getState().generationComplete).toBe(true);
});

it('aborts unused parallel content when action generation pauses the batch', async () => {
  settings.parallelSceneConcurrency = 2;
  let pendingSignal: AbortSignal | null | undefined;
  fetchMock.mockImplementation((url, init) => {
    const body = JSON.parse(String(init?.body));
    if (String(url).endsWith('scene-actions')) return Promise.resolve(failed());
    if (body.outline.order === 0) return Promise.resolve(success(String(url), init!));
    pendingSignal = init?.signal;
    return new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  });
  await generator.generateRemaining(params);
  expect(pendingSignal?.aborted).toBe(true);
  expect(useStageStore.getState().failedOutlines).toEqual([outlines[0]]);
  expect(useStageStore.getState().generatingOutlines).toEqual([]);
  expect(generator.isGenerating()).toBe(false);
});

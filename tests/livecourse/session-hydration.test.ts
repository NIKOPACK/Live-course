// @vitest-environment jsdom

import 'fake-indexeddb/auto';
import { BrowserRuntimeStore, type RuntimeStore } from '@livecourse/storage';
import { act, createElement, Fragment, StrictMode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { lessonPlanSchema, projectGoalState } from '@/lib/livecourse/domain';
import * as evidenceRepository from '@/lib/livecourse/evidence/runtime-repository';
import type { Scene } from '@/lib/types/stage';
import { useStageStore } from '@/lib/store';
import { createCourseStateRepository } from '@/lib/livecourse/session/course-state-repository';
import {
  createTeachingActionRepository,
  livecourseActionSessionId,
} from '@/lib/livecourse/session/action-repository';
import {
  LEARNER_MEMORY_PARTITION_STAGE_ID,
  learnerMemorySessionId,
  workingMemorySessionId,
} from '@/lib/livecourse/memory/namespaces';
import { createLearnerMemoryRepository } from '@/lib/livecourse/memory/repository';
import {
  LiveCourseSessionProvider,
  useLiveCourseSession,
  type LiveCourseSessionValue,
} from '@/lib/livecourse/session/context';
import { ClassroomSessionBoundary } from '@/components/livecourse/ClassroomSessionBoundary';
import { COURSE_ID, LESSON_ONE, makeCourseSnapshotInput } from './course-state-fixture';
import { makeEvidenceRecord } from './evidence-fixture';

const mocks = vi.hoisted(() => ({
  store: null as RuntimeStore | null,
  getLearnerKey: vi.fn<() => Promise<string>>(),
  childMounted: vi.fn(),
}));
vi.mock('@/lib/runtime/store', () => ({ getRuntimeStore: () => mocks.store }));
vi.mock('@/lib/runtime/learner-key', () => ({ getLearnerKey: mocks.getLearnerKey }));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const STAGE_ID = 'stage-1';
const LEARNER_ID = 'learner-1';
const scope = {
  stageId: STAGE_ID,
  learnerId: LEARNER_ID,
  courseId: COURSE_ID,
  lessonId: LESSON_ONE,
};
const actionSessionId = livecourseActionSessionId(scope);
const workingSessionId = workingMemorySessionId({ ...scope, classroomSessionId: actionSessionId });
const learnerSessionId = learnerMemorySessionId({ learnerId: LEARNER_ID });
const existingEvidence = makeEvidenceRecord();
let store: BrowserRuntimeStore;
let root: Root;
let container: HTMLDivElement;
let current: LiveCourseSessionValue;

function Probe() {
  const session = useLiveCourseSession();
  useEffect(() => {
    current = session;
  }, [session]);
  return null;
}
function TeachingChild() {
  useEffect(() => {
    mocks.childMounted();
  }, []);
  return createElement('div', { 'data-testid': 'teaching-child' }, 'Teaching');
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function renderProvider(sessionEnabled = true) {
  const props = {
    courseId: COURSE_ID,
    lessonId: LESSON_ONE,
    sessionEnabled,
    children: sessionEnabled
      ? createElement(
          Fragment,
          null,
          createElement(Probe),
          createElement(ClassroomSessionBoundary, null, createElement(TeachingChild)),
        )
      : null,
  };
  await act(async () => {
    root.render(createElement(StrictMode, null, createElement(LiveCourseSessionProvider, props)));
  });
}
async function waitForStatus(status: LiveCourseSessionValue['status']) {
  const deadline = Date.now() + 1000;
  while (current.status !== status && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(current.status, current.error ?? undefined).toBe(status);
}
async function retry() {
  await act(async () => current.retryHydration());
}
async function durableImage() {
  const sessions = (
    await Promise.all([
      store.listSessions(STAGE_ID, LEARNER_ID),
      store.listSessions(LEARNER_MEMORY_PARTITION_STAGE_ID, LEARNER_ID),
    ])
  )
    .flat()
    .sort((a, b) => a.id.localeCompare(b.id));
  return Promise.all(
    sessions.map(async (session) => ({ session, records: await store.listRecords(session.id) })),
  );
}
async function nonWorkingImage() {
  return (await durableImage()).filter(
    ({ session }) => ![actionSessionId, workingSessionId].includes(session.id),
  );
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Hydration tests must not access the network');
    }),
  );
  mocks.getLearnerKey.mockReset().mockResolvedValue(LEARNER_ID);
  mocks.childMounted.mockClear();
  store = new BrowserRuntimeStore({ dbName: `session-hydration-${crypto.randomUUID()}` });
  mocks.store = store;
  const input = makeCourseSnapshotInput();
  const lesson = input.coursePlan.lessons.find((item) => item.id === LESSON_ONE)!;
  const nodes = lesson.nodes.map((node) => ({ ...node, sceneId: node.id.slice('node:'.length) }));
  const scenes: Scene[] = nodes.map((node) => ({
    id: node.sceneId,
    stageId: STAGE_ID,
    title: node.title,
    order: node.order,
    type: 'quiz',
    content: {
      type: 'quiz',
      questions: [],
      html: '<html><head></head><body>Checkpoint</body></html>',
    },
  }));
  useStageStore.setState({
    stage: { id: STAGE_ID, name: 'Hydration lesson', createdAt: 0, updatedAt: 0 },
    scenes,
    currentSceneId: scenes[0].id,
    lessonPlan: lessonPlanSchema.parse({
      schemaVersion: 1,
      id: 'lesson-plan:stage-1',
      courseId: COURSE_ID,
      stageId: STAGE_ID,
      title: 'Hydration lesson',
      version: 1,
      status: 'approved',
      createdAt: input.coursePlan.createdAt,
      goals: input.coursePlan.goals,
      nodes,
      presentation: { mode: 'html', visualStyle: 'Ink diagrams on warm paper.' },
    }),
  });
  await createCourseStateRepository({ store, ...scope }).save(input);
  await createLearnerMemoryRepository({ store, scope: { learnerId: LEARNER_ID } }).update(
    (memory) => ({
      ...memory,
      updatedAt: '2026-09-01T00:00:00.000Z',
    }),
  );
  await evidenceRepository.appendEvidenceRecord(STAGE_ID, existingEvidence, { store, ...scope });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  container.remove();
});

describe('real session hydration and recovery boundary', () => {
  it('shows read failure, coalesces explicit retries, and mounts teaching only after success', async () => {
    const read = evidenceRepository.listEvidenceRecords;
    let failEvidence = true;
    const gate = deferred<void>();
    let retryReadCount = 0;
    vi.spyOn(evidenceRepository, 'listEvidenceRecords').mockImplementation(
      async (stageId, deps) => {
        if (failEvidence) throw new Error('Evidence storage unavailable');
        if (retryReadCount++ === 0) await gate.promise;
        return read(stageId, deps);
      },
    );
    const baseline = await durableImage();
    await renderProvider();
    await waitForStatus('error');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Evidence storage unavailable',
    );
    expect(document.activeElement).toBe(container.querySelector('button'));
    expect(mocks.childMounted).not.toHaveBeenCalled();
    expect(await durableImage()).toEqual(baseline);

    failEvidence = false;
    const retryCommand = current.retryHydration;
    await act(async () => {
      retryCommand();
      retryCommand();
    });
    expect(current.status).toBe('loading');
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(mocks.childMounted).not.toHaveBeenCalled();
    await act(async () => gate.resolve());
    await waitForStatus('ready');
    expect(current.currentNodeId).toBe('node:lesson-1-b');
    expect(useStageStore.getState().currentSceneId).toBe('lesson-1-b');
    expect(container.querySelector('[data-testid="teaching-child"]')).not.toBeNull();
    expect(mocks.getLearnerKey).toHaveBeenCalledTimes(1);
    const actions = await createTeachingActionRepository({ store, ...scope }).load();
    expect(actions.actions).toHaveLength(1);
    expect(await nonWorkingImage()).toEqual(baseline);
    const mountedCount = mocks.childMounted.mock.calls.length;
    await act(async () => retryCommand());
    expect(current.status).toBe('ready');
    expect(mocks.childMounted).toHaveBeenCalledTimes(mountedCount);
  });

  it('retries a rejected runtime initialization without remounting the provider', async () => {
    mocks.getLearnerKey.mockRejectedValueOnce(new Error('Identity unavailable'));
    await renderProvider();
    await waitForStatus('error');
    expect(current.error).toBe('Identity unavailable');
    await retry();
    await waitForStatus('ready');
    expect(mocks.getLearnerKey).toHaveBeenCalledTimes(2);
  });

  it('preserves an already committed resume W when a later L read fails repeatedly', async () => {
    const before = await nonWorkingImage();
    const read = store.getSession.bind(store);
    let failLearner = true;
    vi.spyOn(store, 'getSession').mockImplementation(async (id) => {
      if (failLearner && id === learnerSessionId) throw new Error('Learner memory unavailable');
      return read(id);
    });
    await renderProvider();
    await waitForStatus('error');
    const originalActions = await store.listRecords(actionSessionId);
    const originalWorking = await store.listRecords(workingSessionId);
    expect(originalActions).toHaveLength(1);
    expect(originalWorking).toHaveLength(1);
    await retry();
    await waitForStatus('error');
    expect(await store.listRecords(actionSessionId)).toEqual(originalActions);
    expect(await store.listRecords(workingSessionId)).toEqual(originalWorking);
    expect(mocks.childMounted).not.toHaveBeenCalled();
    failLearner = false;
    await retry();
    await waitForStatus('ready');
    expect(await store.listRecords(actionSessionId)).toEqual(originalActions);
    expect(await store.listRecords(workingSessionId)).toEqual(originalWorking);
    expect(await nonWorkingImage()).toEqual(before);
    expect(current.evidence).toEqual([existingEvidence]);
    expect(current.goalStates).toEqual(
      current.lessonPlan!.goals.map((goal) =>
        projectGoalState({
          courseId: COURSE_ID,
          learnerId: LEARNER_ID,
          goalId: goal.id,
          rule: goal.rule,
          evidence: [existingEvidence],
        }),
      ),
    );
  });

  it.each([false, true])(
    'repairs a failed W projection (committed=%s) using the original durable resume action',
    async (committed) => {
      const append = store.appendRecord.bind(store);
      let failWorking = true;
      vi.spyOn(store, 'appendRecord').mockImplementation(async (record, options) => {
        if (failWorking && record.sessionId === workingSessionId) {
          if (committed) await append(record, options);
          throw new Error('Working projection unavailable');
        }
        return append(record, options);
      });
      const before = await nonWorkingImage();
      await renderProvider();
      await waitForStatus('error');
      const actions = await store.listRecords(actionSessionId);
      expect(actions).toHaveLength(1);
      expect(await store.listRecords(workingSessionId)).toHaveLength(committed ? 1 : 0);
      failWorking = false;
      await retry();
      await waitForStatus('ready');
      expect(await store.listRecords(actionSessionId)).toEqual(actions);
      expect(await store.listRecords(workingSessionId)).toHaveLength(1);
      expect(await nonWorkingImage()).toEqual(before);
    },
  );

  it('ignores a pending read after disabling the teaching lifecycle without creating W', async () => {
    const read = evidenceRepository.listEvidenceRecords;
    const gate = deferred<void>();
    const pendingRead = vi
      .spyOn(evidenceRepository, 'listEvidenceRecords')
      .mockImplementation(async (stageId, deps) => {
        await gate.promise;
        return read(stageId, deps);
      });
    const before = await durableImage();
    await renderProvider();
    expect(pendingRead).toHaveBeenCalledOnce();
    const staleRetry = current.retryHydration;
    await renderProvider(false);
    await act(async () => gate.resolve());
    expect(() => staleRetry()).toThrow('disabled');
    expect(await durableImage()).toEqual(before);
    expect(mocks.childMounted).not.toHaveBeenCalled();
  });

  it('keeps command failures in the ready classroom instead of restarting hydration', async () => {
    await renderProvider();
    await waitForStatus('ready');
    const before = await durableImage();
    const mountedCount = mocks.childMounted.mock.calls.length;
    await act(async () => {
      await expect(current.finalizeSession()).rejects.toThrow();
    });
    expect(current.status).toBe('ready');
    expect(current.error).not.toBeNull();
    expect(container.querySelector('[data-testid="teaching-child"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await retry();
    expect(mocks.childMounted).toHaveBeenCalledTimes(mountedCount);
    expect(await durableImage()).toEqual(before);
  });
});

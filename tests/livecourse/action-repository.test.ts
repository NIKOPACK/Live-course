import 'fake-indexeddb/auto';

import { BrowserRuntimeStore } from '@livecourse/storage';
import { describe, expect, it } from 'vitest';

import { teachingActionSchema, type TeachingAction } from '@/lib/livecourse/domain';
import {
  LIVECOURSE_ACTION_KIND,
  TeachingActionIdempotencyConflictError,
  TeachingActionSequenceError,
  TeachingActionSessionNotActiveError,
  createTeachingActionRepository,
  livecourseActionSessionId,
  livecourseReplaySessionId,
} from '@/lib/livecourse/session/action-repository';

function action(overrides: Partial<TeachingAction> = {}): TeachingAction {
  return teachingActionSchema.parse({
    schemaVersion: 1,
    id: 'action-0',
    courseId: 'course-1',
    lessonId: 'lesson-1',
    nodeId: 'node:scene-1',
    sequence: 0,
    timestamp: '2026-08-10T08:00:00.000Z',
    idempotencyKey: 'request-0',
    type: 'stage.highlight',
    payload: { sceneId: 'scene-1', elementId: 'element-1', color: '#ff0000' },
    ...overrides,
  });
}

function setup() {
  const store = new BrowserRuntimeStore({
    dbName: `livecourse-actions-${crypto.randomUUID()}`,
  });
  const options = {
    store,
    stageId: 'stage-1',
    learnerId: 'learner-1',
    courseId: 'course-1',
    lessonId: 'lesson-1',
    now: () => '2026-08-10T07:59:00.000Z',
  };
  return { store, options, repository: createTeachingActionRepository(options) };
}

describe('LiveCourse teaching action repository', () => {
  it('persists complete TeachingActions and folds the durable recovery point', async () => {
    const { store, options, repository } = setup();
    const first = action();
    const second = action({
      id: 'action-1',
      sequence: 1,
      timestamp: '2026-08-10T08:01:00.000Z',
      idempotencyKey: 'request-1',
      type: 'lesson.goto_node',
      payload: { targetNodeId: 'node:scene-2' },
    });

    await repository.append(first);
    await repository.append(second);

    const snapshot = await repository.load();
    expect(snapshot).toEqual({
      actions: [first, second],
      currentNodeId: 'node:scene-2',
      lastSequence: 1,
    });

    const sessionId = livecourseActionSessionId(options);
    const session = await store.getSession(sessionId);
    const records = await store.listRecords(sessionId);
    expect(session).toMatchObject({ kind: LIVECOURSE_ACTION_KIND, status: 'active' });
    expect(records.map((record) => record.payload)).toEqual([first, second]);
  });

  it('requires every new action sequence to equal lastSequence + 1', async () => {
    const { store, options, repository } = setup();

    await expect(repository.append(action({ sequence: 1 }))).rejects.toBeInstanceOf(
      TeachingActionSequenceError,
    );
    await expect(store.getSession(livecourseActionSessionId(options))).resolves.toBeUndefined();
    await repository.append(action());
    await expect(
      repository.append(
        action({
          id: 'action-2',
          sequence: 2,
          idempotencyKey: 'request-2',
        }),
      ),
    ).rejects.toMatchObject({ actualSequence: 2, expectedSequence: 1 });

    await expect(repository.load()).resolves.toMatchObject({ lastSequence: 0 });
  });

  it('normalizes optional undefined members before writing RuntimeStore payloads', async () => {
    const { store, options, repository } = setup();
    const withUndefined = action({
      payload: {
        sceneId: 'scene-1',
        elementId: 'element-1',
        color: '#ff0000',
        durationMs: undefined,
      },
    });

    const result = await repository.append(withUndefined);
    const [record] = await store.listRecords(livecourseActionSessionId(options));

    expect(result.action).toEqual(action());
    expect(record?.payload).toEqual(action());
    expect(Object.hasOwn(result.action.payload, 'durationMs')).toBe(false);
  });

  it('fails closed for completed sessions at every read/write boundary', async () => {
    const { store, options, repository } = setup();
    const first = action();
    const sessionId = livecourseActionSessionId(options);
    await repository.append(first);
    await store.setSessionStatus(sessionId, 'completed', '2026-08-10T08:02:00.000Z');

    await expect(repository.load()).rejects.toBeInstanceOf(TeachingActionSessionNotActiveError);
    await expect(
      repository.inspect(action({ sequence: 1, id: 'inspect-action' })),
    ).rejects.toBeInstanceOf(TeachingActionSessionNotActiveError);
    await expect(
      repository.append(action({ id: 'action-1', sequence: 1, idempotencyKey: 'request-1' })),
    ).rejects.toBeInstanceOf(TeachingActionSessionNotActiveError);
    await expect(repository.destroy()).rejects.toBeInstanceOf(TeachingActionSessionNotActiveError);
    await expect(store.getSession(livecourseActionSessionId(options))).resolves.toBeDefined();
  });

  it('returns the original action for a semantic retry with the same idempotency key', async () => {
    const { store, options, repository } = setup();
    const original = action();
    await repository.append(original);

    const retry = action({
      id: 'retry-action',
      sequence: 1,
      timestamp: '2026-08-10T08:05:00.000Z',
    });
    const result = await repository.append(retry);

    expect(result).toEqual({
      action: original,
      duplicate: true,
      recoveryPoint: { currentNodeId: original.nodeId, lastSequence: 0 },
    });
    expect(await store.listRecords(livecourseActionSessionId(options))).toHaveLength(1);
  });

  it('rejects an idempotency key reused for different action semantics', async () => {
    const { repository } = setup();
    await repository.append(action());

    await expect(
      repository.append(
        action({
          id: 'conflicting-action',
          sequence: 1,
          payload: { sceneId: 'scene-1', elementId: 'element-1', color: '#00ff00' },
        }),
      ),
    ).rejects.toBeInstanceOf(TeachingActionIdempotencyConflictError);
    await expect(repository.load()).resolves.toMatchObject({ lastSequence: 0 });
  });

  it('does not let replay cleanup delete a non-active replay session', async () => {
    const { store, options } = setup();
    const replayId = 'replay-closed';
    const replayRepository = createTeachingActionRepository({ ...options, replayId });
    await replayRepository.append(action());
    const replaySessionId = livecourseReplaySessionId({
      stageId: options.stageId,
      learnerId: options.learnerId,
      courseId: options.courseId,
      lessonId: options.lessonId,
      replayId,
    });
    await store.setSessionStatus(replaySessionId, 'archived', '2026-08-10T08:03:00.000Z');

    await expect(replayRepository.load()).rejects.toBeInstanceOf(
      TeachingActionSessionNotActiveError,
    );
    await expect(replayRepository.destroy()).rejects.toBeInstanceOf(
      TeachingActionSessionNotActiveError,
    );
    await expect(store.getSession(replaySessionId)).resolves.toBeDefined();
  });
});

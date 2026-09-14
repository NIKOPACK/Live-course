import 'fake-indexeddb/auto';

import { BrowserRuntimeStore } from '@livecourse/storage';
import { describe, expect, it } from 'vitest';

import { evidenceRecordSchema, type EvidenceRecord } from '@/lib/livecourse/domain';
import {
  appendEvidenceRecord,
  listEvidenceRecords,
} from '@/lib/livecourse/evidence/runtime-repository';
import { APP_RUNTIME_PAYLOAD_VALIDATORS } from '@/lib/runtime/payload-validators';

function evidence(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return evidenceRecordSchema.parse({
    schemaVersion: 1,
    id: 'evidence:quiz:attempt-1',
    courseId: 'course-1',
    lessonId: 'lesson-1',
    learnerId: 'learner-1',
    goalId: 'goal-1',
    nodeId: 'node:quiz-1',
    source: 'checkpoint',
    kind: 'objective_score',
    status: 'accepted',
    score: 0.8,
    occurredAt: '2026-08-10T08:00:00.000Z',
    idempotencyKey: 'quiz-review:attempt-1',
    evaluation: { method: 'deterministic', ruleVersion: 'choice-v1' },
    ...overrides,
  });
}

describe('LiveCourse RuntimeStore evidence repository', () => {
  it('appends once and returns the durable record for a retried submission', async () => {
    const store = new BrowserRuntimeStore({
      dbName: `livecourse-evidence-${crypto.randomUUID()}`,
      payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    });
    const deps = { store, learnerId: 'learner-1', courseId: 'course-1' };

    const first = await appendEvidenceRecord('stage-1', evidence(), deps);
    const retry = await appendEvidenceRecord(
      'stage-1',
      evidence({ occurredAt: '2026-08-10T08:01:00.000Z' }),
      deps,
    );
    const records = await listEvidenceRecords('stage-1', deps);

    expect(retry).toEqual(first);
    expect(records).toEqual([first]);
  });

  it('rejects reuse of an idempotency key for a different score', async () => {
    const store = new BrowserRuntimeStore({
      dbName: `livecourse-evidence-conflict-${crypto.randomUUID()}`,
      payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    });
    const deps = { store, learnerId: 'learner-1', courseId: 'course-1' };
    await appendEvidenceRecord('stage-1', evidence(), deps);

    await expect(
      appendEvidenceRecord(
        'stage-1',
        evidence({ id: 'evidence:quiz:attempt-2', score: 0.2 }),
        deps,
      ),
    ).rejects.toThrow('Evidence idempotency conflict');
  });

  it('reads only the explicitly requested course partition', async () => {
    const store = new BrowserRuntimeStore({
      dbName: `livecourse-evidence-course-filter-${crypto.randomUUID()}`,
      payloadValidators: APP_RUNTIME_PAYLOAD_VALIDATORS,
    });
    await appendEvidenceRecord(
      'stage-1',
      evidence({ id: 'evidence-a', idempotencyKey: 'attempt-a', courseId: 'course-1' }),
      { store, learnerId: 'learner-1', courseId: 'course-1' },
    );
    await appendEvidenceRecord(
      'stage-1',
      evidence({ id: 'evidence-b', idempotencyKey: 'attempt-b', courseId: 'course-2' }),
      { store, learnerId: 'learner-1', courseId: 'course-2' },
    );

    await expect(
      listEvidenceRecords('stage-1', { store, learnerId: 'learner-1', courseId: 'course-1' }),
    ).resolves.toEqual([expect.objectContaining({ courseId: 'course-1' })]);
  });
});

/**
 * Shared fixtures and a fake ledger for P-003 evidence/adjustment tests.
 * The fake ledger mirrors the runtime repository's idempotency semantics:
 * a repeated semantic record returns the first write; conflicting reuse of an
 * id or idempotency key errors loudly.
 */
import {
  evidenceRecordSchema,
  coursePlanSchema,
  type CoursePlan,
  type EvidenceRecord,
} from '@/lib/livecourse/domain';
import type {
  EvidenceLedgerPort,
  EvidencePersistenceScope,
} from '@/lib/livecourse/evidence/ingestion';

export function makeEvidenceRecord(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return evidenceRecordSchema.parse({
    schemaVersion: 1,
    id: 'evidence-1',
    courseId: 'course:algebra',
    lessonId: 'lesson-1',
    learnerId: 'learner-1',
    goalId: 'goal:one',
    nodeId: 'node:lesson-1-a',
    source: 'checkpoint',
    kind: 'objective_score',
    status: 'accepted',
    score: 0.9,
    occurredAt: '2026-08-10T08:00:00.000Z',
    idempotencyKey: 'attempt-1',
    evaluation: { method: 'deterministic', ruleVersion: 'choice-v1' },
    ...overrides,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

function sameEvidence(left: EvidenceRecord, right: EvidenceRecord): boolean {
  const { occurredAt: _left, ...leftStable } = evidenceRecordSchema.parse(left);
  const { occurredAt: _right, ...rightStable } = evidenceRecordSchema.parse(right);
  return canonicalJson(leftStable) === canonicalJson(rightStable);
}

export interface FakeEvidenceLedger extends EvidenceLedgerPort {
  readonly records: EvidenceRecord[];
}

/** In-memory ledger with runtime-equivalent idempotency/conflict semantics. */
export function createFakeEvidenceLedger(): FakeEvidenceLedger {
  const partitions = new Map<string, EvidenceRecord[]>();
  const records: EvidenceRecord[] = [];
  const partitionKey = (scope: EvidencePersistenceScope) =>
    `${scope.stageId}\u0000${scope.learnerId}`;

  return {
    records,
    async list(scope) {
      return [...(partitions.get(partitionKey(scope)) ?? [])];
    },
    async write(scope, candidate) {
      const key = partitionKey(scope);
      const partition = partitions.get(key) ?? [];
      const existing = partition.find(
        (record) =>
          record.id === candidate.id || record.idempotencyKey === candidate.idempotencyKey,
      );
      if (existing) {
        if (!sameEvidence(existing, candidate)) {
          throw new Error(
            `Evidence idempotency conflict for ${JSON.stringify(candidate.idempotencyKey)}`,
          );
        }
        return existing;
      }
      partition.push(candidate);
      partitions.set(key, partition);
      records.push(candidate);
      return candidate;
    },
  };
}

export function makeAdjustmentCoursePlan(
  overrides: {
    version?: number;
    checkpointRules?: CoursePlan['checkpointRules'];
  } = {},
): CoursePlan {
  return coursePlanSchema.parse({
    schemaVersion: 1,
    id: 'course-plan:algebra',
    courseId: 'course:algebra',
    title: 'Algebra',
    version: overrides.version ?? 3,
    status: 'approved',
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
    goals: [
      {
        id: 'goal:one',
        title: 'Solve linear equations',
        description: 'Apply inverse operations correctly.',
        rule: {
          version: 'rule:v1',
          passScore: 0.7,
          minAcceptedEvidence: 1,
          minPassingEvidence: 1,
        },
      },
    ],
    lessons: [
      {
        id: 'lesson-1',
        stageId: 'stage-1',
        title: 'Linear equations',
        order: 0,
        dependsOn: [],
        nodes: [
          {
            id: 'node:lesson-1-a',
            sceneId: 'scene:lesson-1-a',
            title: 'Introduction',
            type: 'instruction',
            order: 0,
            goalIds: ['goal:one'],
          },
          {
            id: 'node:lesson-1-b',
            sceneId: 'scene:lesson-1-b',
            title: 'Guided practice',
            type: 'interactive',
            order: 1,
            goalIds: ['goal:one'],
          },
        ],
      },
      {
        id: 'lesson-2',
        stageId: 'stage-2',
        title: 'Applications',
        order: 1,
        dependsOn: ['lesson-1'],
        nodes: [
          {
            id: 'node:lesson-2-a',
            sceneId: 'scene:lesson-2-a',
            title: 'Word problems',
            type: 'project',
            order: 0,
            goalIds: ['goal:one'],
          },
        ],
      },
    ],
    checkpointRules: overrides.checkpointRules ?? [
      {
        id: 'checkpoint:lesson-1-a',
        nodeId: 'node:lesson-1-a',
        goalIds: ['goal:one'],
        required: true,
      },
    ],
  });
}

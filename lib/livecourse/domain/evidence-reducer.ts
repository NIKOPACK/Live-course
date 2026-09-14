import {
  evidenceRecordSchema,
  goalStateSchema,
  type EvidenceRecord,
  type GoalRule,
  type GoalState,
} from './schemas';

export class EvidenceConflictError extends Error {
  override readonly name = 'EvidenceConflictError';

  constructor(key: 'id' | 'idempotencyKey', value: string) {
    super(`Conflicting evidence records share ${key} ${JSON.stringify(value)}`);
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

function deduplicateEvidence(records: readonly EvidenceRecord[]): EvidenceRecord[] {
  const byId = new Map<string, EvidenceRecord>();
  const byIdempotencyKey = new Map<string, EvidenceRecord>();

  for (const raw of records) {
    const record = evidenceRecordSchema.parse(raw);
    const serialized = stableJson(record);
    const sameId = byId.get(record.id);
    if (sameId && stableJson(sameId) !== serialized) {
      throw new EvidenceConflictError('id', record.id);
    }
    const sameKey = byIdempotencyKey.get(record.idempotencyKey);
    if (sameKey && stableJson(sameKey) !== serialized) {
      throw new EvidenceConflictError('idempotencyKey', record.idempotencyKey);
    }
    byId.set(record.id, record);
    byIdempotencyKey.set(record.idempotencyKey, record);
  }

  return [...byIdempotencyKey.values()].sort(
    (left, right) =>
      left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id),
  );
}

export function projectGoalState(input: {
  courseId: string;
  learnerId: string;
  goalId: string;
  rule: GoalRule;
  evidence: readonly EvidenceRecord[];
}): GoalState {
  const relevant = deduplicateEvidence(input.evidence).filter(
    (record) =>
      record.courseId === input.courseId &&
      record.learnerId === input.learnerId &&
      record.goalId === input.goalId,
  );
  const accepted = relevant.filter(
    (record): record is EvidenceRecord & { score: number } =>
      record.status === 'accepted' && record.score !== undefined,
  );
  const passingEvidenceCount = accepted.filter(
    (record) => record.score >= input.rule.passScore,
  ).length;
  // A pending model record that already received an explicit teacher decision
  // (via the teacher_review ingestion path) is no longer "waiting": the
  // decision record itself carries the accepted/rejected outcome.
  const decidedPendingIds = new Set(
    relevant
      .filter(
        (record) =>
          record.source === 'teacher_review' &&
          (record.status === 'accepted' || record.status === 'rejected') &&
          typeof record.metadata?.reviewedEvidenceId === 'string',
      )
      .map((record) => record.metadata?.reviewedEvidenceId as string),
  );
  const pendingReviewCount = relevant.filter(
    (record) => record.status === 'pending_review' && !decidedPendingIds.has(record.id),
  ).length;
  const isMet =
    accepted.length >= input.rule.minAcceptedEvidence &&
    passingEvidenceCount >= input.rule.minPassingEvidence;

  const status: GoalState['status'] =
    relevant.length === 0
      ? 'not_started'
      : isMet
        ? 'met'
        : accepted.length >= input.rule.minAcceptedEvidence
          ? 'needs_support'
          : 'in_progress';
  const scores = accepted.map((record) => record.score);
  const latestScore = accepted.at(-1)?.score ?? null;
  const averageScore =
    scores.length === 0 ? null : scores.reduce((sum, score) => sum + score, 0) / scores.length;

  return goalStateSchema.parse({
    schemaVersion: 1,
    courseId: input.courseId,
    learnerId: input.learnerId,
    goalId: input.goalId,
    ruleVersion: input.rule.version,
    status,
    evidenceIds: relevant.map((record) => record.id),
    acceptedEvidenceCount: accepted.length,
    pendingReviewCount,
    passingEvidenceCount,
    latestScore,
    averageScore,
    updatedAt: relevant.at(-1)?.occurredAt ?? null,
  });
}

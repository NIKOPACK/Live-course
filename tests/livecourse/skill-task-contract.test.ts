/**
 * P-005 — Subject Skill task contract (A-009).
 *
 * Verifies that a declarative checkpoint-evaluation Skill:
 *   - maps only to its declared assistant task kind and tools
 *   - produces pending evidence through the shared ingestion boundary
 *   - rejects unknown Skill/kind/tool requests
 *   - rejects missing required input references
 *   - rejects cross-context invocations
 *   - rejects direct/unconfirmed result application
 *
 * Uses an in-memory fake ledger so no persistence infrastructure is needed.
 */
import { describe, expect, it } from 'vitest';

import { AssistantTaskService } from '@/lib/livecourse/domain';
import { EvidenceIngestionService } from '@/lib/livecourse/evidence/ingestion';
import { createFakeEvidenceLedger } from '@/tests/livecourse/evidence-fixture';

import {
  SUBJECT_SKILL_ID,
  SUBJECT_SKILL_KIND,
  SUBJECT_SKILL_TOOLS,
  SubjectSkillValidationError,
  validateSubjectSkillInvocation,
  type SubjectSkillExecutionContext,
  type SubjectSkillEvaluationResult,
  type SubjectSkillInvocation,
} from '@/lib/livecourse/domain/subject-skill';
import {
  mapSubjectSkillResultToEvidence,
  SubjectSkillEvidenceError,
} from '@/lib/livecourse/evidence/subject-skill-evidence';

const CONTEXT: SubjectSkillExecutionContext = {
  courseId: 'course:algebra',
  lessonId: 'lesson-1',
  learnerId: 'learner-42',
  nodeId: 'node:checkpoint-1',
  goalId: 'goal:one',
  stageId: 'stage-1',
};

const RESULT: SubjectSkillEvaluationResult = {
  skillId: SUBJECT_SKILL_ID,
  checkpointId: 'checkpoint:lesson-1-a',
  rubricId: 'rubric:linear-equations-v1',
  score: 0.85,
  summary: 'Checkpoint evaluated; the learner correctly applied inverse operations.',
};

function makeTask(
  service: AssistantTaskService,
  overrides: Partial<Parameters<typeof service.create>[0]> = {},
) {
  return service.create({
    courseId: 'course:algebra',
    lessonId: 'lesson-1',
    nodeId: 'node:checkpoint-1',
    sceneId: 'scene:lesson-1-a',
    kind: SUBJECT_SKILL_KIND,
    delegatedBy: 'teacher:1',
    assistantId: 'assistant:skill-1',
    inputRefs: ['checkpoint:lesson-1-a', 'rubric:linear-equations-v1'],
    idempotencyKey: 'skill-test-1',
    ...overrides,
  });
}

function makeSucceededTask(service: AssistantTaskService) {
  const task = makeTask(service);
  service.start(task.id);
  service.succeed(task.id, {
    kind: 'draft_feedback',
    summary: 'Skill evaluation completed.',
    content: 'Score: 0.85',
  });
  return service.get(task.id);
}

describe('Subject Skill task contract (A-009)', () => {
  describe('declaration', () => {
    it('declares a stable id, kind, tool allowlist and required input prefixes', () => {
      expect(SUBJECT_SKILL_ID).toBe('skill:checkpoint-evaluation:v1');
      expect(SUBJECT_SKILL_KIND).toBe('draft_feedback');
      expect(SUBJECT_SKILL_TOOLS).toContain('read_checkpoint');
      expect(SUBJECT_SKILL_TOOLS).toContain('grade_with_rubric');
    });
  });

  describe('validateSubjectSkillInvocation', () => {
    it('validates a valid succeeded task against the declaration', () => {
      const service = new AssistantTaskService({ now: () => '2026-08-17T08:00:00.000Z' });
      const task = makeSucceededTask(service);

      const invocation = validateSubjectSkillInvocation(task, CONTEXT);

      expect(invocation.skillId).toBe(SUBJECT_SKILL_ID);
      expect(invocation.kind).toBe(SUBJECT_SKILL_KIND);
      expect(invocation.status).toBe('succeeded');
      expect(invocation.courseId).toBe('course:algebra');
      expect(invocation.lessonId).toBe('lesson-1');
      expect(invocation.nodeId).toBe('node:checkpoint-1');
      expect(invocation.inputRefs).toContain('checkpoint:lesson-1-a');
      expect(invocation.inputRefs).toContain('rubric:linear-equations-v1');
      expect(invocation.tools).toEqual(SUBJECT_SKILL_TOOLS);
      // D-0010: stageId is carried from context and is NOT derived from courseId
      expect(invocation.stageId).toBe('stage-1');
      expect(invocation.stageId).not.toBe(invocation.courseId);
    });

    it('rejects a task with a non-matching kind', () => {
      const service = new AssistantTaskService({ now: () => '2026-08-17T08:00:00.000Z' });
      const task = makeTask(service, { kind: 'summarize_source' as const });
      service.start(task.id);
      service.succeed(task.id, {
        kind: 'summarize_source',
        summary: 'test',
        sourceId: 'source-1',
      });
      const mismatched = service.get(task.id);

      expect(() => validateSubjectSkillInvocation(mismatched, CONTEXT)).toThrow(
        SubjectSkillValidationError,
      );
      expect(() => validateSubjectSkillInvocation(mismatched, CONTEXT)).toThrow(/kind/i);
    });

    it('rejects a non-succeeded task', () => {
      const service = new AssistantTaskService({ now: () => '2026-08-17T08:00:00.000Z' });
      const task = makeTask(service); // status = 'queued'

      expect(() => validateSubjectSkillInvocation(task, CONTEXT)).toThrow(
        SubjectSkillValidationError,
      );
      expect(() => validateSubjectSkillInvocation(task, CONTEXT)).toThrow(/succeeded/);
    });

    it('rejects a task with a non-allowlisted tool', () => {
      const service = new AssistantTaskService({ now: () => '2026-08-17T08:00:00.000Z' });
      const task = makeSucceededTask(service);

      expect(() =>
        validateSubjectSkillInvocation(task, CONTEXT, ['read_checkpoint', 'arbitrary_tool']),
      ).toThrow(SubjectSkillValidationError);
      expect(() =>
        validateSubjectSkillInvocation(task, CONTEXT, ['read_checkpoint', 'arbitrary_tool']),
      ).toThrow(/not allowlisted/i);
    });

    it('rejects a task with an unknown kind', () => {
      const service = new AssistantTaskService({ now: () => '2026-08-17T08:00:00.000Z' });
      const task = makeTask(service, { kind: 'draft_board_note' as const });
      service.start(task.id);
      service.succeed(task.id, {
        kind: 'draft_board_note',
        summary: 'test',
        content: 'Note content',
      });
      const mismatched = service.get(task.id);

      expect(() => validateSubjectSkillInvocation(mismatched, CONTEXT)).toThrow(/kind/i);
    });

    it('rejects a task missing required input reference prefixes', () => {
      const service = new AssistantTaskService({ now: () => '2026-08-17T08:00:00.000Z' });
      const task = makeTask(service, { inputRefs: ['source-1', 'source-2'] });
      service.start(task.id);
      service.succeed(task.id, {
        kind: 'draft_feedback',
        summary: 'test',
        content: 'Note',
      });
      const missing = service.get(task.id);

      expect(() => validateSubjectSkillInvocation(missing, CONTEXT)).toThrow(
        SubjectSkillValidationError,
      );
      expect(() => validateSubjectSkillInvocation(missing, CONTEXT)).toThrow(/input ref/i);
    });

    it('rejects a task with foreign input refs not on the allowed surface', () => {
      const service = new AssistantTaskService({ now: () => '2026-08-17T08:00:00.000Z' });
      const task = makeTask(service, {
        inputRefs: ['checkpoint:lesson-1-a', 'rubric:linear-equations-v1', 'foreign:bad-ref'],
      });
      service.start(task.id);
      service.succeed(task.id, {
        kind: 'draft_feedback',
        summary: 'test',
        content: 'Note',
      });
      const foreign = service.get(task.id);

      expect(() => validateSubjectSkillInvocation(foreign, CONTEXT)).toThrow(
        SubjectSkillValidationError,
      );
      expect(() => validateSubjectSkillInvocation(foreign, CONTEXT)).toThrow(/foreign/i);
    });

    it('rejects a context with missing stageId', () => {
      const service = new AssistantTaskService({ now: () => '2026-08-17T08:00:00.000Z' });
      const task = makeSucceededTask(service);

      expect(() => validateSubjectSkillInvocation(task, { ...CONTEXT, stageId: '' })).toThrow(
        SubjectSkillValidationError,
      );
      expect(() => validateSubjectSkillInvocation(task, { ...CONTEXT, stageId: '' })).toThrow(
        /stageId/,
      );
    });

    it('rejects cross-context invocation (non-matching course/lesson/node)', () => {
      const service = new AssistantTaskService({ now: () => '2026-08-17T08:00:00.000Z' });
      const task = makeSucceededTask(service);

      expect(() =>
        validateSubjectSkillInvocation(task, { ...CONTEXT, courseId: 'course:other' }),
      ).toThrow(/does not match/i);
      expect(() =>
        validateSubjectSkillInvocation(task, { ...CONTEXT, lessonId: 'lesson-other' }),
      ).toThrow(/does not match/i);
      expect(() =>
        validateSubjectSkillInvocation(task, { ...CONTEXT, nodeId: 'node:other' }),
      ).toThrow(/does not match/i);
    });
  });

  describe('mapSubjectSkillResultToEvidence', () => {
    it('maps a validated invocation and structured result to pending evidence under the supplied stage/learner partition', async () => {
      const ledger = createFakeEvidenceLedger();
      const service = new EvidenceIngestionService(ledger, {
        now: () => '2026-08-17T08:00:00.000Z',
      });

      const taskService = new AssistantTaskService({ now: () => '2026-08-17T08:00:00.000Z' });
      const task = makeSucceededTask(taskService);
      const invocation = validateSubjectSkillInvocation(task, CONTEXT);

      const record = await mapSubjectSkillResultToEvidence(service, {
        context: CONTEXT,
        invocation,
        result: RESULT,
        modelId: 'subject-skill-model',
        rubricVersion: 'subject-skill-rubric-v1',
      });

      expect(record.status).toBe('pending_review');
      expect(record.source).toBe('checkpoint');
      expect(record.kind).toBe('rubric_score');
      expect(record.courseId).toBe('course:algebra');
      expect(record.lessonId).toBe('lesson-1');
      expect(record.learnerId).toBe('learner-42');
      expect(record.goalId).toBe('goal:one');
      expect(record.nodeId).toBe('node:checkpoint-1');
      expect(record.score).toBe(0.85);
      expect(record.evaluation).toMatchObject({
        method: 'model',
        modelId: 'subject-skill-model',
        reviewStatus: 'pending',
      });
      expect(record.metadata).toMatchObject({
        skillId: SUBJECT_SKILL_ID,
        checkpointId: 'checkpoint:lesson-1-a',
        rubricId: 'rubric:linear-equations-v1',
        taskId: task.id,
      });
      expect(ledger.records).toHaveLength(1);

      // D-0010: verify the record is written under the supplied stage/learner partition
      const scoped = await ledger.list({ stageId: 'stage-1', learnerId: 'learner-42' });
      expect(scoped).toHaveLength(1);
      expect(scoped[0].id).toBe(record.id);

      // A different partition does NOT contain this record
      const foreign = await ledger.list({ stageId: 'stage-other', learnerId: 'learner-42' });
      expect(foreign).toHaveLength(0);
    });

    it('rejects a non-succeeded invocation (context mismatch)', async () => {
      const ledger = createFakeEvidenceLedger();
      const service = new EvidenceIngestionService(ledger, {
        now: () => '2026-08-17T08:00:00.000Z',
      });

      // Build a forged invocation with mismatched learner
      const badInvocation: SubjectSkillInvocation = {
        skillId: SUBJECT_SKILL_ID,
        kind: SUBJECT_SKILL_KIND,
        status: 'succeeded' as const,
        taskId: 'task:not-real',
        taskVersion: 1,
        courseId: 'course:algebra',
        lessonId: 'lesson-1',
        learnerId: 'learner-other',
        nodeId: 'node:checkpoint-1',
        goalId: 'goal:one',
        stageId: 'stage-1',
        inputRefs: ['checkpoint:lesson-1-a', 'rubric:linear-equations-v1'],
        tools: Object.freeze([...SUBJECT_SKILL_TOOLS]),
      };

      expect(() =>
        mapSubjectSkillResultToEvidence(service, {
          context: CONTEXT,
          invocation: badInvocation,
          result: RESULT,
          modelId: 'subject-skill-model',
        }),
      ).toThrow(SubjectSkillEvidenceError);
      expect(ledger.records).toHaveLength(0);
    });

    it('rejects a result with non-matching skillId', async () => {
      const ledger = createFakeEvidenceLedger();
      const service = new EvidenceIngestionService(ledger, {
        now: () => '2026-08-17T08:00:00.000Z',
      });

      const taskService = new AssistantTaskService({ now: () => '2026-08-17T08:00:00.000Z' });
      const task = makeSucceededTask(taskService);
      const invocation = validateSubjectSkillInvocation(task, CONTEXT);

      // Deliberately invalid at runtime: the declared literal type would
      // otherwise reject the unknown skillId, so we cross that boundary via
      // `unknown` instead of weakening the production type with `any`.
      const forgedResult: SubjectSkillEvaluationResult = {
        ...RESULT,
        skillId: 'skill:unknown' as unknown as SubjectSkillEvaluationResult['skillId'],
      };

      expect(() =>
        mapSubjectSkillResultToEvidence(service, {
          context: CONTEXT,
          invocation,
          result: forgedResult,
          modelId: 'subject-skill-model',
        }),
      ).toThrow(SubjectSkillEvidenceError);
      expect(ledger.records).toHaveLength(0);
    });

    it('rejects a result with invalid score', async () => {
      const ledger = createFakeEvidenceLedger();
      const service = new EvidenceIngestionService(ledger, {
        now: () => '2026-08-17T08:00:00.000Z',
      });

      const taskService = new AssistantTaskService({ now: () => '2026-08-17T08:00:00.000Z' });
      const task = makeSucceededTask(taskService);
      const invocation = validateSubjectSkillInvocation(task, CONTEXT);

      expect(() =>
        mapSubjectSkillResultToEvidence(service, {
          context: CONTEXT,
          invocation,
          result: { ...RESULT, score: -0.1 },
          modelId: 'subject-skill-model',
        }),
      ).toThrow(SubjectSkillEvidenceError);
      expect(ledger.records).toHaveLength(0);
    });

    it('rejects a result with empty summary', async () => {
      const ledger = createFakeEvidenceLedger();
      const service = new EvidenceIngestionService(ledger, {
        now: () => '2026-08-17T08:00:00.000Z',
      });

      const taskService = new AssistantTaskService({ now: () => '2026-08-17T08:00:00.000Z' });
      const task = makeSucceededTask(taskService);
      const invocation = validateSubjectSkillInvocation(task, CONTEXT);

      expect(() =>
        mapSubjectSkillResultToEvidence(service, {
          context: CONTEXT,
          invocation,
          result: { ...RESULT, summary: '' },
          modelId: 'subject-skill-model',
        }),
      ).toThrow(SubjectSkillEvidenceError);
      expect(ledger.records).toHaveLength(0);
    });

    it('rejects a context with missing stageId', async () => {
      const ledger = createFakeEvidenceLedger();
      const service = new EvidenceIngestionService(ledger, {
        now: () => '2026-08-17T08:00:00.000Z',
      });

      const taskService = new AssistantTaskService({ now: () => '2026-08-17T08:00:00.000Z' });
      const task = makeSucceededTask(taskService);
      const invocation = validateSubjectSkillInvocation(task, CONTEXT);

      expect(() =>
        mapSubjectSkillResultToEvidence(service, {
          context: { ...CONTEXT, stageId: '' },
          invocation,
          result: RESULT,
          modelId: 'subject-skill-model',
        }),
      ).toThrow(SubjectSkillEvidenceError);
      expect(() =>
        mapSubjectSkillResultToEvidence(service, {
          context: { ...CONTEXT, stageId: '' },
          invocation,
          result: RESULT,
          modelId: 'subject-skill-model',
        }),
      ).toThrow(/stageId/i);
      expect(ledger.records).toHaveLength(0);
    });

    it('rejects a foreign stage scope — context stage does not match invocation stage', async () => {
      const ledger = createFakeEvidenceLedger();
      const service = new EvidenceIngestionService(ledger, {
        now: () => '2026-08-17T08:00:00.000Z',
      });

      const taskService = new AssistantTaskService({ now: () => '2026-08-17T08:00:00.000Z' });
      const task = makeSucceededTask(taskService);
      const invocation = validateSubjectSkillInvocation(task, CONTEXT);

      // Forge a context with a different stageId than the validated invocation
      expect(() =>
        mapSubjectSkillResultToEvidence(service, {
          context: { ...CONTEXT, stageId: 'stage-foreign' },
          invocation,
          result: RESULT,
          modelId: 'subject-skill-model',
        }),
      ).toThrow(SubjectSkillEvidenceError);
      expect(() =>
        mapSubjectSkillResultToEvidence(service, {
          context: { ...CONTEXT, stageId: 'stage-foreign' },
          invocation,
          result: RESULT,
          modelId: 'subject-skill-model',
        }),
      ).toThrow(/stage.*match/i);
      expect(ledger.records).toHaveLength(0);
    });

    it('cannot become accepted evidence — always produces pending_review', async () => {
      const ledger = createFakeEvidenceLedger();
      const service = new EvidenceIngestionService(ledger, {
        now: () => '2026-08-17T08:00:00.000Z',
      });

      const taskService = new AssistantTaskService({ now: () => '2026-08-17T08:00:00.000Z' });
      const task = makeSucceededTask(taskService);
      const invocation = validateSubjectSkillInvocation(task, CONTEXT);

      const record = await mapSubjectSkillResultToEvidence(service, {
        context: CONTEXT,
        invocation,
        result: RESULT,
        modelId: 'subject-skill-model',
      });

      expect(record.status).toBe('pending_review');
      // The ingestion service has no path that accepts model evidence directly
      expect(record.status).not.toBe('accepted');
    });
  });
});

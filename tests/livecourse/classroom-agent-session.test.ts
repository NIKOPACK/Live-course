import { afterEach, describe, expect, it } from 'vitest';

import { createRealtimeToolsRouteHandler } from '@/app/api/livecourse/realtime/tools/handler';
import { POST as postTasks } from '@/app/api/livecourse/agent-session/tasks/route';
import { POST as postConfirm } from '@/app/api/livecourse/agent-session/tasks/[taskId]/confirm/route';
import { POST as postApplied } from '@/app/api/livecourse/agent-session/tasks/[taskId]/confirm/applied/route';
import { POST as postCancel } from '@/app/api/livecourse/agent-session/tasks/[taskId]/cancel/route';
import {
  agentSessionCookieHeader,
  ClassroomAgentSessionService,
  deriveClassroomAgents,
  deriveCoursePlanFromClassroomShape,
  InMemoryClassroomAgentSessionStore,
  readAgentSessionToken,
  type ClassroomAgentSessionRecord,
  type ClassroomAgentSessionStateView,
  type ClassroomAgents,
} from '@/lib/livecourse/realtime/server/classroom-agent-session';
import {
  configureClassroomAgentSessionService,
  resetClassroomAgentSessionRuntime,
} from '@/lib/livecourse/realtime/server/classroom-agent-session-runtime';
import { deterministicAssistantExecutor } from './fixtures/deterministic-assistant-executor';

const START = '2026-08-17T01:00:00.000Z';

function classroomShape() {
  return {
    courseId: 'course-1',
    stageId: 'course-1',
    stageTitle: '教学闭环课程',
    now: START,
    scenes: [
      { id: 'scene-0', title: '引言', order: 0 },
      { id: 'scene-1', title: '核心检查点', order: 1, type: 'quiz' },
      { id: 'scene-2', title: '收尾', order: 2 },
    ],
  };
}

/** Injected only in tests that still exercise the leftover assistant-task API. */
function testClassroomAgents(input: {
  courseId: string;
  lessonId: string;
  stageId: string;
  learnerId: string;
}): ClassroomAgents {
  const digest = input.courseId.replace(/[^a-z0-9]+/gi, '').slice(0, 16) || 'test';
  return {
    realtimeTeacherAgentId: `realtime-teacher:${input.courseId}:${digest}`,
    assistantRoster: [
      {
        assistantAgentId: `assistant-notes-${digest}`,
        allowedTaskKinds: ['draft_board_note', 'draft_feedback'],
        allowedTools: ['draft_classroom_note'],
      },
      {
        assistantAgentId: `assistant-source-${digest}`,
        allowedTaskKinds: ['summarize_source'],
        allowedTools: ['read_source_reference'],
      },
      {
        assistantAgentId: `assistant-next-${digest}`,
        allowedTaskKinds: ['suggest_next_step'],
        allowedTools: ['read_lesson_reference'],
      },
    ],
  };
}

function setup(options: { agents?: ClassroomAgents } = {}) {
  let currentTime = START;
  const clock = () => currentTime;
  const advance = (ms: number) => {
    currentTime = new Date(new Date(currentTime).getTime() + ms).toISOString();
  };
  const store = new InMemoryClassroomAgentSessionStore();
  const service = new ClassroomAgentSessionService({
    store,
    executor: deterministicAssistantExecutor,
    clock,
    ttlMs: 60_000,
    resolveCoursePlan: ({ courseId, stageId }) =>
      deriveCoursePlanFromClassroomShape({
        ...classroomShape(),
        courseId,
        stageId,
        scenes: classroomShape().scenes,
      }),
    resolveClassroomAgents: (input) =>
      options.agents ? options.agents : testClassroomAgents(input),
  });
  return { service, store, clock, advance };
}

async function establish(service: ClassroomAgentSessionService, learnerId = 'learner-1') {
  return service.establish({ classroomId: 'course-1', learnerId });
}

function notesAssistant(session: ClassroomAgentSessionRecord): string {
  const entry = session.assistantRoster.find((candidate) =>
    candidate.allowedTaskKinds.includes('draft_board_note'),
  );
  if (!entry) throw new Error('notes assistant not found');
  return entry.assistantAgentId;
}

function realtimeToolBody(view: ClassroomAgentSessionStateView, tool: unknown, callId = 'call-1') {
  return {
    courseId: view.coursePlan.courseId,
    lessonId: view.lessonId,
    nodeId: view.location.nodeId,
    sceneId: view.location.sceneId,
    callId,
    tool,
  };
}

async function succeededTask(service: ClassroomAgentSessionService, token: string, taskId: string) {
  const view = await service.stateView(token);
  const task = view.tasks.find((item) => item.id === taskId);
  expect(task?.status).toBe('succeeded');
  return view;
}

afterEach(() => {
  resetClassroomAgentSessionRuntime();
});

describe('ClassroomAgentSession — server derivation', () => {
  it('derives a single-lesson plan with scene scope from the classroom document', () => {
    const plan = deriveCoursePlanFromClassroomShape(classroomShape());
    expect(plan.lessons).toHaveLength(1);
    const [lesson] = plan.lessons;
    expect(lesson.nodes.map((node) => node.sceneId)).toEqual(['scene-0', 'scene-1', 'scene-2']);
    expect(lesson.dependsOn).toEqual([]);
    const checkpoint = lesson.nodes.find((node) => node.sceneId === 'scene-1');
    expect(checkpoint?.type).toBe('checkpoint');
    expect(checkpoint?.goalIds).toEqual(['goal:scene-1']);
    expect(plan.goals.some((goal) => goal.id === 'goal:scene-1')).toBe(true);
  });

  it('production default roster has no assistants', () => {
    const agents = deriveClassroomAgents({
      courseId: 'course-1',
      lessonId: 'lesson:course-1:1',
      stageId: 'course-1',
      learnerId: 'learner-1',
    });
    expect(agents.assistantRoster).toEqual([]);
    expect(agents.realtimeTeacherAgentId).toMatch(/^realtime-teacher:/);
  });

  it('derives a fallback goal when the classroom has no quiz scene', () => {
    const plan = deriveCoursePlanFromClassroomShape({
      ...classroomShape(),
      scenes: [
        { id: 'scene-0', title: 'A', order: 0 },
        { id: 'scene-1', title: 'B', order: 1 },
      ],
    });
    const fallback = plan.goals.find((goal) => goal.id === 'goal:course-1:lesson');
    expect(fallback).toBeDefined();
    for (const lesson of plan.lessons) {
      for (const node of lesson.nodes) {
        expect(node.goalIds).toContain('goal:course-1:lesson');
      }
    }
  });

  it('rejects classrooms that have no lesson scenes', () => {
    expect(() =>
      deriveCoursePlanFromClassroomShape({
        ...classroomShape(),
        scenes: [],
      }),
    ).toThrow(/at least one lesson scene/);
  });
});

describe('ClassroomAgentSession — session lifecycle', () => {
  it('establishes a server-owned session and restores it on re-establishment', async () => {
    const { service, store } = setup();
    const first = await establish(service);
    expect(first.restored).toBe(false);
    expect(first.session.realtimeTeacherAgentId).toMatch(/^realtime-teacher:/);
    expect(first.session.assistantRoster.length).toBeGreaterThan(0);
    expect(store.binding('course-1', 'learner-1')).toBe(first.token);

    const second = await service.establish({
      classroomId: 'course-1',
      learnerId: 'learner-1',
      resumeToken: first.token,
    });
    expect(second.restored).toBe(true);
    expect(second.session.sessionId).toBe(first.session.sessionId);
  });

  it('does not disclose an existing session from a guessed learner id', async () => {
    const { service } = setup();
    const first = await establish(service);

    await expect(establish(service)).rejects.toMatchObject({
      code: 'SESSION_RESUME_REQUIRED',
      status: 403,
    });
    await expect(
      service.establish({
        classroomId: 'course-1',
        learnerId: 'learner-1',
        resumeToken: 'forged-token',
      }),
    ).rejects.toMatchObject({ code: 'SESSION_RESUME_REQUIRED', status: 403 });
    expect(service.resolveToken(first.token).session.sessionId).toBe(first.token);
  });

  it('fails closed for forged and expired tokens', async () => {
    const { service, advance } = setup();
    const { token } = await establish(service);
    expect(() => service.resolveToken('forged-token')).toThrow(
      expect.objectContaining({ code: 'SESSION_MISSING' }),
    );
    expect(() => service.resolveToken('')).toThrow(
      expect.objectContaining({ code: 'SESSION_INVALID' }),
    );
    advance(61_000);
    expect(() => service.resolveToken(token)).toThrow(
      expect.objectContaining({ code: 'SESSION_EXPIRED' }),
    );
    expect(() =>
      service.delegate(token, {
        assistantId: 'x',
        kind: 'draft_board_note',
        inputRefs: [],
        callId: 'c',
      }),
    ).toThrow(expect.objectContaining({ code: 'SESSION_EXPIRED' }));
  });

  it('serializes and parses the opaque cookie', () => {
    const header = agentSessionCookieHeader('session:abc-123', '2026-08-17T02:00:00.000Z', {
      secure: true,
    });
    expect(header).toContain('lc-agent-session=session%3Aabc-123');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    const request = new Request('http://localhost/x', {
      headers: { cookie: 'other=1; lc-agent-session=session%3Aabc-123' },
    });
    expect(readAgentSessionToken(request)).toBe('session:abc-123');
    expect(readAgentSessionToken(new Request('http://localhost/x'))).toBeNull();
    expect(
      readAgentSessionToken(
        new Request('http://localhost/x', {
          headers: { cookie: `lc-agent-session=${'x'.repeat(129)}` },
        }),
      ),
    ).toBeNull();
  });
});

describe('ClassroomAgentSession — session-bound delegation', () => {
  it('delegates a rostered task as the session teacher and runs it to success', async () => {
    const { service } = setup();
    const { token, session } = await establish(service);
    const task = service.delegate(token, {
      assistantId: notesAssistant(session),
      kind: 'draft_board_note',
      inputRefs: ['note:已确认的板书要点'],
      callId: 'call-1',
    });
    expect(task.status).toBe('queued');
    expect(task.delegatedBy).toBe(session.realtimeTeacherAgentId);
    expect(task.assistantId).toBe(notesAssistant(session));
    expect(task.courseId).toBe('course-1');
    expect(task.lessonId).toBe(session.lessonId);

    const view = await succeededTask(service, token, task.id);
    const done = view.tasks.find((item) => item.id === task.id)!;
    expect(done.status).toBe('succeeded');
    expect(done.result?.kind).toBe('draft_board_note');
    expect(done.result?.content).toBe('已确认的板书要点');
  });

  it('returns the same task for a semantic retry and rejects conflicting idempotency reuse', async () => {
    const { service } = setup();
    const { token, session } = await establish(service);
    const first = service.delegate(token, {
      assistantId: notesAssistant(session),
      kind: 'draft_board_note',
      inputRefs: ['note:same'],
      callId: 'call-retry',
    });
    const second = service.delegate(token, {
      assistantId: notesAssistant(session),
      kind: 'draft_board_note',
      inputRefs: ['note:same'],
      callId: 'call-retry',
    });
    expect(second.id).toBe(first.id);
    expect(() =>
      service.delegate(token, {
        assistantId: notesAssistant(session),
        kind: 'draft_feedback',
        inputRefs: ['note:different'],
        callId: 'call-retry',
      }),
    ).toThrow(
      expect.objectContaining({ code: 'ASSISTANT_TASK_IDEMPOTENCY_CONFLICT', status: 409 }),
    );
  });

  it.each([
    [
      'unknown assistant',
      { assistantId: 'not-in-roster', kind: 'draft_board_note', inputRefs: ['note:x'] },
      'ASSISTANT_NOT_ROSTERED',
    ],
    [
      'kind outside allowlist',
      { kind: 'suggest_next_step', inputRefs: ['node:scene-2'] },
      'ASSISTANT_KIND_NOT_ALLOWED',
    ],
  ])('rejects %s', async (_label, overrides, code) => {
    const { service } = setup();
    const { token, session } = await establish(service);
    expect(() =>
      service.delegate(token, {
        assistantId: notesAssistant(session),
        ...overrides,
        callId: 'call-reject',
      }),
    ).toThrow(expect.objectContaining({ code }));
  });

  it('rejects an unknown task kind and a kind whose tool is not allowlisted', async () => {
    const { service } = setup();
    const { token, session } = await establish(service);
    expect(() =>
      service.delegate(token, {
        assistantId: notesAssistant(session),
        kind: 'run_script',
        inputRefs: [],
        callId: 'call-kind',
      }),
    ).toThrow(expect.objectContaining({ code: 'UNKNOWN_TASK_KIND' }));

    // assistant-source may summarize but its tools only cover source reading —
    // a draft_board_note delegation must fail the tool check at the session level.
    const sourceAssistant = session.assistantRoster.find((entry) =>
      entry.allowedTaskKinds.includes('summarize_source'),
    )!;
    expect(() =>
      service.delegate(token, {
        assistantId: sourceAssistant.assistantAgentId,
        kind: 'draft_board_note',
        inputRefs: ['note:x'],
        callId: 'call-tool',
      }),
    ).toThrow(expect.objectContaining({ code: 'ASSISTANT_KIND_NOT_ALLOWED' }));
  });

  it('rejects a roster whose allowedTools do not cover the kind capability', async () => {
    const { service } = setup({
      agents: {
        realtimeTeacherAgentId: 'teacher-1',
        assistantRoster: [
          {
            assistantAgentId: 'assistant-1',
            allowedTaskKinds: ['draft_board_note'],
            allowedTools: ['read_source_reference'],
          },
        ],
      },
    });
    const { token } = await establish(service);
    expect(() =>
      service.delegate(token, {
        assistantId: 'assistant-1',
        kind: 'draft_board_note',
        inputRefs: ['note:x'],
        callId: 'call-tool',
      }),
    ).toThrow(expect.objectContaining({ code: 'ASSISTANT_TOOL_NOT_ALLOWED' }));
  });

  it('fails closed for cross node/scene/course/lesson scope', async () => {
    const { service } = setup();
    const { token, session } = await establish(service);
    const notes = notesAssistant(session);

    // node not part of the current lesson scope
    expect(() =>
      service.delegate(token, {
        assistantId: notes,
        kind: 'draft_board_note',
        inputRefs: ['note:x'],
        callId: 'call-node',
        nodeId: 'node:foreign',
        sceneId: 'scene-foreign',
      }),
    ).toThrow(expect.objectContaining({ code: 'CLASSROOM_NODE_MISMATCH' }));

    // node/scene pair mismatch
    expect(() =>
      service.delegate(token, {
        assistantId: notes,
        kind: 'draft_board_note',
        inputRefs: ['note:x'],
        callId: 'call-scene',
        nodeId: 'node:scene-0',
        sceneId: 'scene-2',
      }),
    ).toThrow(expect.objectContaining({ code: 'CLASSROOM_SCENE_MISMATCH' }));

    // location update outside the scope is rejected before it is stored
    expect(() =>
      service.updateLocation(token, { nodeId: 'node:foreign', sceneId: 'scene-foreign' }),
    ).toThrow(expect.objectContaining({ code: 'CLASSROOM_NODE_MISMATCH' }));

    // realtime tool entry validates course and lesson against the session
    const snapshot = await service.stateView(token);
    expect(() =>
      service.delegateTool(token, {
        ...realtimeToolBody(snapshot, {
          name: 'delegate_assistant_task',
          arguments: { assistantId: notes, kind: 'draft_board_note', inputRefs: ['note:x'] },
        }),
        courseId: 'other-course',
      } as never),
    ).toThrow(expect.objectContaining({ code: 'CLASSROOM_COURSE_MISMATCH' }));

    expect(() =>
      service.delegateTool(token, {
        ...realtimeToolBody(snapshot, {
          name: 'delegate_assistant_task',
          arguments: { assistantId: notes, kind: 'draft_board_note', inputRefs: ['note:x'] },
        }),
        lessonId: 'lesson:other',
      } as never),
    ).toThrow(expect.objectContaining({ code: 'CLASSROOM_LESSON_MISMATCH' }));
  });

  it('delegates through the session-bound realtime handler as the session teacher', async () => {
    const { service } = setup();
    const { token, session } = await establish(service);
    const handler = createRealtimeToolsRouteHandler({
      identity: { learnerId: 'learner-1' },
      sessionDelegator: async () => ({
        delegate: (request) => Promise.resolve(service.delegateTool(token, request)),
      }),
    });
    const notes = notesAssistant(session);
    const view = await service.stateView(token);
    const response = await handler(
      new Request('http://localhost/api/livecourse/realtime/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-learner-key': 'learner-1' },
        body: JSON.stringify(
          realtimeToolBody(view, {
            name: 'delegate_assistant_task',
            arguments: { assistantId: notes, kind: 'draft_board_note', inputRefs: ['note:hi'] },
          }),
        ),
      }),
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.success).toBe(true);
    expect(payload.task.delegatedBy).toBe(session.realtimeTeacherAgentId);
  });

  it('rejects a forged x-teacher-key on the session-bound realtime route', async () => {
    const { service } = setup();
    const { token, session } = await establish(service);
    const handler = createRealtimeToolsRouteHandler({
      identity: { learnerId: 'learner-1' },
      sessionDelegator: async () => ({
        delegate: (request) => Promise.resolve(service.delegateTool(token, request)),
      }),
    });
    const notes = notesAssistant(session);
    const view = await service.stateView(token);
    const response = await handler(
      new Request('http://localhost/api/livecourse/realtime/tools', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-learner-key': 'learner-1',
          // A forged teacher header must fail closed, never be ignored.
          'x-teacher-key': 'forged-teacher',
        },
        body: JSON.stringify(
          realtimeToolBody(view, {
            name: 'delegate_assistant_task',
            arguments: { assistantId: notes, kind: 'draft_board_note', inputRefs: ['note:hi'] },
          }),
        ),
      }),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'FORGED_AGENT_IDENTITY' },
    });
    // The forged header never reached the service: no task was created.
    expect(service.resolveToken(token).state.tasks.list()).toHaveLength(0);
  });

  it('fails closed when no session cookie is present on the realtime route', async () => {
    const handler = createRealtimeToolsRouteHandler({
      identity: { learnerId: 'learner-1' },
      sessionDelegator: async () => null,
    });
    const response = await handler(
      new Request('http://localhost/api/livecourse/realtime/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-learner-key': 'learner-1' },
        body: JSON.stringify({
          courseId: 'course-1',
          lessonId: 'lesson-1',
          nodeId: 'node-1',
          sceneId: 'scene-1',
          callId: 'call-1',
          tool: {
            name: 'delegate_assistant_task',
            arguments: { assistantId: 'a', kind: 'draft_board_note', inputRefs: [] },
          },
        }),
      }),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'SESSION_REQUIRED' },
    });
  });
});

describe('ClassroomAgentSession — confirmation boundary', () => {
  it('rejects confirmation before the task succeeds', async () => {
    const { service } = setup();
    const { token, session } = await establish(service);
    const task = service.delegate(token, {
      assistantId: notesAssistant(session),
      kind: 'draft_board_note',
      inputRefs: ['note:x'],
      callId: 'call-confirm-early',
    });
    expect(() => service.confirmTask(token, task.id)).toThrow(
      expect.objectContaining({ code: 'CONFIRMATION_NOT_ALLOWED', status: 409 }),
    );
  });

  it('confirms a succeeded task as the session teacher and returns one command', async () => {
    const { service, advance } = setup();
    const { token, session } = await establish(service);
    const task = service.delegate(token, {
      assistantId: notesAssistant(session),
      kind: 'draft_board_note',
      inputRefs: ['note:批准内容'],
      callId: 'call-confirm',
    });
    await succeededTask(service, token, task.id);
    const confirmed = service.confirmTask(token, task.id);
    expect(confirmed.task.confirmation?.confirmedBy).toBe(session.realtimeTeacherAgentId);
    expect(confirmed.task.confirmation?.applicationStatus).toBe('pending');
    expect(confirmed.command.type).toBe('board.apply');
    expect(confirmed.command.idempotencyKey).toBe(`assistant-confirm:${task.id}`);
    const confirmedAt = confirmed.task.confirmation?.confirmedAt;
    // Confirming again is idempotent even after wall-clock time advances.
    advance(1_000);
    const again = service.confirmTask(token, task.id);
    expect(again.task.id).toBe(confirmed.task.id);
    expect(again.task.confirmation?.confirmedAt).toBe(confirmedAt);

    const applied = service.markTaskApplied(token, task.id, confirmed.command.idempotencyKey);
    expect(applied.confirmation?.applicationStatus).toBe('applied');
    expect(applied.confirmation?.appliedAt).toBeTruthy();
  });

  it('a failed task can never be confirmed into success', async () => {
    const { service } = setup();
    const { token, session } = await establish(service);
    const source = session.assistantRoster.find((entry) =>
      entry.allowedTaskKinds.includes('summarize_source'),
    )!;
    // no source: reference → the executor fails the task explicitly
    const task = service.delegate(token, {
      assistantId: source.assistantAgentId,
      kind: 'summarize_source',
      inputRefs: ['note:not-a-source'],
      callId: 'call-fail',
    });
    const view = await service.stateView(token);
    const failed = view.tasks.find((item) => item.id === task.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBeTruthy();
    expect(() => service.confirmTask(token, task.id)).toThrow(
      expect.objectContaining({ code: 'CONFIRMATION_NOT_ALLOWED' }),
    );
  });

  it('cancels queued tasks and never lets a cancelled task succeed', async () => {
    const { service } = setup();
    const { token, session } = await establish(service);
    const task = service.delegate(token, {
      assistantId: notesAssistant(session),
      kind: 'draft_board_note',
      inputRefs: ['note:x'],
      callId: 'call-cancel',
    });
    const cancelled = service.cancelTask(token, task.id, 'teacher cancelled');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancellationReason).toContain('teacher cancelled');
    const view = await service.stateView(token);
    expect(view.tasks.find((item) => item.id === task.id)?.status).toBe('cancelled');
    expect(() => service.confirmTask(token, task.id)).toThrow(
      expect.objectContaining({ code: 'CONFIRMATION_NOT_ALLOWED' }),
    );
    // cancelling again is idempotent; cancelling a succeeded task is rejected
    expect(service.cancelTask(token, task.id, 'again').status).toBe('cancelled');
    const succeeded = service.delegate(token, {
      assistantId: notesAssistant(session),
      kind: 'draft_board_note',
      inputRefs: ['note:done'],
      callId: 'call-cancel-succeeded',
    });
    await service.stateView(token);
    expect(service.resolveToken(token).state.tasks.get(succeeded.id).status).toBe('succeeded');
    expect(() => service.cancelTask(token, succeeded.id, 'too late')).toThrow(
      expect.objectContaining({ code: 'TASK_CANCEL_NOT_ALLOWED' }),
    );
  });
});

describe('ClassroomAgentSession — recovery retains equivalent semantics', () => {
  it('reload recovery restores the same session with tasks, plan and lesson intact', async () => {
    const { service, advance } = setup();
    const { token, session } = await establish(service);
    const notes = notesAssistant(session);

    const task = service.delegate(token, {
      assistantId: notes,
      kind: 'draft_board_note',
      inputRefs: ['note:恢复语义'],
      callId: 'call-recovery',
    });
    await succeededTask(service, token, task.id);
    const confirmed = service.confirmTask(token, task.id);
    service.markTaskApplied(token, task.id, confirmed.command.idempotencyKey);

    // A fresh page load re-establishes from the store binding.
    advance(5_000);
    const restored = await service.establish({
      classroomId: 'course-1',
      learnerId: 'learner-1',
      resumeToken: token,
    });
    expect(restored.restored).toBe(true);
    expect(restored.session.sessionId).toBe(session.sessionId);
    const recovered = await service.stateView(restored.token);
    expect(recovered.coursePlan.version).toBe(1);
    expect(recovered.lessonId).toBe(`lesson:course-1:1`);
    const confirmedTask = recovered.tasks.find((item) => item.id === task.id)!;
    expect(confirmedTask.status).toBe('succeeded');
    expect(confirmedTask.confirmation?.confirmedBy).toBe(session.realtimeTeacherAgentId);
    expect(confirmedTask.confirmation?.applicationStatus).toBe('applied');
    expect(recovered.evidence).toHaveLength(0);
    const nextTask = service.delegate(restored.token, {
      assistantId: notes,
      kind: 'draft_board_note',
      inputRefs: ['note:恢复后任务'],
      callId: 'call-after-recovery',
    });
    expect(nextTask.lessonId).toBe(`lesson:course-1:1`);
  });

  it('the persistence boundary round-trips terminal and requeued task states', async () => {
    const { service } = setup();
    const { token, session } = await establish(service);
    const notes = notesAssistant(session);
    const done = service.delegate(token, {
      assistantId: notes,
      kind: 'draft_board_note',
      inputRefs: ['note:done'],
      callId: 'call-done',
    });
    await succeededTask(service, token, done.id);
    service.confirmTask(token, done.id);
    const running = service.delegate(token, {
      assistantId: notes,
      kind: 'draft_board_note',
      inputRefs: ['note:running'],
      callId: 'call-running',
    });
    // Force one task to stay running before the scheduled run fires: recovery
    // must explicitly requeue unfinished work.
    service.resolveToken(token).state.tasks.start(running.id);

    const entry = service.resolveToken(token);
    const snapshot = service.snapshotForSession(entry.session, entry.state);
    const recovered = service.recoverStateFromSnapshot(snapshot);
    expect(recovered.state.coursePlan.version).toBe(1);
    expect(recovered.sessionFields.lessonId).toBe(snapshot.lessonId);
    expect(recovered.sessionFields.stageId).toBe(snapshot.stageId);
    const recoveredDone = recovered.state.tasks.get(done.id);
    expect(recoveredDone.status).toBe('succeeded');
    expect(recoveredDone.confirmation?.confirmedBy).toBe(session.realtimeTeacherAgentId);
    const recoveredRunning = recovered.state.tasks.get(running.id);
    expect(recoveredRunning.status).toBe('queued');
    expect(() => recovered.state.tasks.start(done.id)).toThrow();
  });

  it('rejects a missing or incoherent recovered lesson explicitly', async () => {
    const { service } = setup();
    const { token } = await establish(service);
    const entry = service.resolveToken(token);
    const snapshot = service.snapshotForSession(entry.session, entry.state);

    expect(() => service.recoverStateFromSnapshot({ ...snapshot, lessonId: '' } as never)).toThrow(
      expect.objectContaining({ code: 'RECOVERY_LESSON_INCOHERENT' }),
    );
    expect(() =>
      service.recoverStateFromSnapshot({
        ...snapshot,
        lessonId: 'lesson:does-not-exist',
      } as never),
    ).toThrow(expect.objectContaining({ code: 'RECOVERY_LESSON_INCOHERENT' }));
  });
});

describe('ClassroomAgentSession — HTTP surface', () => {
  it('delegates through the panel API only with a valid session cookie', async () => {
    const { service } = setup();
    const { token, session } = await establish(service);
    configureClassroomAgentSessionService(service);
    const notes = notesAssistant(session);

    const response = await postTasks(
      new Request('http://localhost/api/livecourse/agent-session/tasks', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: agentSessionCookieHeader(token, session.expiresAt),
        },
        body: JSON.stringify({
          assistantId: notes,
          kind: 'draft_board_note',
          inputRefs: ['note:http'],
          idempotencyKey: 'idem-http-base',
        }),
      }),
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.task.status).toBe('queued');
    expect(payload.task.delegatedBy).toBe(session.realtimeTeacherAgentId);

    const missing = await postTasks(
      new Request('http://localhost/api/livecourse/agent-session/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistantId: notes,
          kind: 'draft_board_note',
          inputRefs: [],
          idempotencyKey: 'idem-http-missing',
        }),
      }),
    );
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: 'SESSION_REQUIRED' } });
  });

  it('panel task path is idempotent for retry and 409 on conflicting reuse', async () => {
    const { service } = setup();
    const { token, session } = await establish(service);
    configureClassroomAgentSessionService(service);
    const notes = notesAssistant(session);
    const cookie = agentSessionCookieHeader(token, session.expiresAt);
    const headers = { 'Content-Type': 'application/json', cookie };
    const body = {
      assistantId: notes,
      kind: 'draft_board_note',
      inputRefs: ['note:same'],
      idempotencyKey: 'idem-http-retry',
    };

    const first = await postTasks(
      new Request('http://localhost/api/livecourse/agent-session/tasks', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }),
    );
    expect(first.status).toBe(200);
    const firstTask = (await first.json()).task;

    // Same key + same payload → the exact same task, no duplicate.
    const retry = await postTasks(
      new Request('http://localhost/api/livecourse/agent-session/tasks', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }),
    );
    expect(retry.status).toBe(200);
    const retryTask = (await retry.json()).task;
    expect(retryTask.id).toBe(firstTask.id);

    // Same key + conflicting payload → explicit 409 conflict.
    const conflict = await postTasks(
      new Request('http://localhost/api/livecourse/agent-session/tasks', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, inputRefs: ['note:different'] }),
      }),
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: 'ASSISTANT_TASK_IDEMPOTENCY_CONFLICT' },
    });
    // The conflict never created a second task.
    expect(service.resolveToken(token).state.tasks.list()).toHaveLength(1);

    // A missing idempotency key is a bounded-field 400, never a silent random key.
    const unbounded = await postTasks(
      new Request('http://localhost/api/livecourse/agent-session/tasks', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          assistantId: notes,
          kind: 'draft_board_note',
          inputRefs: ['note:x'],
        }),
      }),
    );
    expect(unbounded.status).toBe(400);
    await expect(unbounded.json()).resolves.toMatchObject({ error: { code: 'INVALID_REQUEST' } });
  });

  it('confirmation identity cannot be forged through the body', async () => {
    const { service } = setup();
    const { token, session } = await establish(service);
    configureClassroomAgentSessionService(service);
    const notes = notesAssistant(session);
    const task = service.delegate(token, {
      assistantId: notes,
      kind: 'draft_board_note',
      inputRefs: ['note:x'],
      callId: 'call-http-confirm',
    });
    await succeededTask(service, token, task.id);

    const forged = await postConfirm(
      new Request('http://localhost/api/livecourse/agent-session/tasks/t/invalid-id/confirm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: agentSessionCookieHeader(token, session.expiresAt),
        },
        body: JSON.stringify({ confirmedBy: 'forged-teacher' }),
      }),
      { params: Promise.resolve({ taskId: task.id }) },
    );
    expect(forged.status).toBe(200);
    const payload = await forged.json();
    expect(payload.task.confirmation.confirmedBy).toBe(session.realtimeTeacherAgentId);
    expect(payload.task.confirmation.applicationStatus).toBe('pending');

    const applied = await postApplied(
      new Request(
        'http://localhost/api/livecourse/agent-session/tasks/t/invalid-id/confirm/applied',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            cookie: agentSessionCookieHeader(token, session.expiresAt),
          },
          body: JSON.stringify({ commandIdempotencyKey: payload.command.idempotencyKey }),
        },
      ),
      { params: Promise.resolve({ taskId: task.id }) },
    );
    expect(applied.status).toBe(200);
    await expect(applied.json()).resolves.toMatchObject({
      task: { confirmation: { applicationStatus: 'applied' } },
    });
  });

  it('cancels a queued task through the HTTP surface', async () => {
    const { service } = setup();
    const { token, session } = await establish(service);
    configureClassroomAgentSessionService(service);
    const notes = notesAssistant(session);
    const task = service.delegate(token, {
      assistantId: notes,
      kind: 'draft_board_note',
      inputRefs: ['note:x'],
      callId: 'call-http-cancel',
    });
    const response = await postCancel(
      new Request('http://localhost/api/livecourse/agent-session/tasks/t/x/cancel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: agentSessionCookieHeader(token, session.expiresAt),
        },
        body: JSON.stringify({ reason: 'http cancel' }),
      }),
      { params: Promise.resolve({ taskId: task.id }) },
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.task.status).toBe('cancelled');
    expect(payload.task.cancellationReason).toBe('http cancel');
  });

  it('a forged cookie fails closed on the state API', async () => {
    const response = await (
      await import('@/app/api/livecourse/agent-session/route')
    ).GET(
      new Request('http://localhost/api/livecourse/agent-session', {
        headers: { cookie: 'lc-agent-session=forged' },
      }),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'SESSION_MISSING' } });
  });
});

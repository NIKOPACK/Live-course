import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildRequestOrigin: vi.fn(),
  persistClassroom: vi.fn(),
  readClassroom: vi.fn(),
  deleteClassroom: vi.fn(),
  sweepJobs: vi.fn(),
}));

vi.mock('@/lib/server/classroom-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/classroom-storage')>()),
  buildRequestOrigin: mocks.buildRequestOrigin,
  persistClassroom: mocks.persistClassroom,
  readClassroom: mocks.readClassroom,
  deleteClassroom: mocks.deleteClassroom,
}));

vi.mock('@/lib/server/classroom-job-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/classroom-job-store')>()),
  sweepClassroomGenerationJobsForClassroom: mocks.sweepJobs,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const stage = {
  id: 'stage-1',
  name: 'Stage',
  createdAt: 1,
  updatedAt: 1,
};

const scenes: never[] = [];

const coursePlan = {
  schemaVersion: 1,
  id: 'course-plan:algebra',
  courseId: 'course:algebra',
  title: 'Algebra',
  version: 1,
  status: 'approved' as const,
  createdAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
  goals: [
    {
      id: 'goal:one',
      title: 'Solve equations',
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
      id: 'lesson:one',
      stageId: 'stage-1',
      title: 'Lesson one',
      order: 0,
      dependsOn: [],
      nodes: [
        {
          id: 'node:one',
          sceneId: 'scene:one',
          title: 'Node one',
          type: 'instruction' as const,
          order: 0,
          goalIds: ['goal:one'],
        },
      ],
    },
  ],
  checkpointRules: [],
};

async function loadRoute() {
  return import('@/app/api/classroom/route');
}

function requestWithBody(body: unknown): NextRequest {
  return new Request('http://localhost/api/classroom', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

describe('/api/classroom boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.buildRequestOrigin.mockReset().mockReturnValue('http://localhost');
    mocks.persistClassroom.mockReset().mockResolvedValue({
      id: 'stage-1',
      url: 'http://localhost/classroom/stage-1',
      stage,
      scenes,
      createdAt: '2026-08-30T00:00:00.000Z',
    });
    mocks.readClassroom.mockReset();
    mocks.deleteClassroom.mockReset().mockResolvedValue(undefined);
    mocks.sweepJobs.mockReset().mockResolvedValue(undefined);
  });

  it('passes a validated course plan through to opaque storage and returns it on GET', async () => {
    const { POST, GET } = await loadRoute();
    const post = await POST(requestWithBody({ stage, scenes, coursePlan }));

    expect(post.status).toBe(201);
    expect(mocks.persistClassroom).toHaveBeenCalledWith(
      { id: 'stage-1', stage, scenes, coursePlan },
      'http://localhost',
    );

    mocks.readClassroom.mockResolvedValueOnce({
      id: 'stage-1',
      stage,
      scenes,
      createdAt: '2026-08-30T00:00:00.000Z',
      coursePlan,
    });
    const get = await GET(new NextRequest('http://localhost/api/classroom?id=stage-1'));
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toMatchObject({ classroom: { coursePlan } });
  });

  it('passes a validated lesson plan through to storage and returns it on GET', async () => {
    const lessonPlan = {
      schemaVersion: 1,
      id: 'lesson-plan:stage-1',
      courseId: 'stage-1',
      stageId: 'stage-1',
      title: 'Designed lesson',
      version: 1,
      status: 'approved' as const,
      createdAt: '2026-09-14T00:00:00.000Z',
      goals: [],
      nodes: [
        {
          id: 'node:one',
          sceneId: 'scene:one',
          title: 'Node one',
          type: 'instruction' as const,
          order: 0,
          goalIds: [],
          design: {
            teachingPoints: ['Point'],
            explanationPlan: 'Explain.',
            anticipatedQuestions: [{ question: 'Why?', response: 'Because.' }],
          },
        },
      ],
    };
    const { POST, GET } = await loadRoute();
    const post = await POST(requestWithBody({ stage, scenes, lessonPlan }));

    expect(post.status).toBe(201);
    expect(mocks.persistClassroom).toHaveBeenCalledWith(
      { id: 'stage-1', stage, scenes, lessonPlan },
      'http://localhost',
    );

    mocks.readClassroom.mockResolvedValueOnce({
      id: 'stage-1',
      stage,
      scenes,
      createdAt: '2026-08-30T00:00:00.000Z',
      lessonPlan,
    });
    const get = await GET(new NextRequest('http://localhost/api/classroom?id=stage-1'));
    expect(get.status).toBe(200);
    await expect(get.json()).resolves.toMatchObject({ classroom: { lessonPlan } });
  });

  it('rejects malformed course plans before touching storage', async () => {
    const { POST } = await loadRoute();
    const response = await POST(
      requestWithBody({ stage, scenes, coursePlan: { schemaVersion: 1, version: 1 } }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });

  it('does not return a semantically malformed stored plan as a legacy classroom', async () => {
    const { GET } = await loadRoute();
    mocks.readClassroom.mockResolvedValueOnce({
      id: 'stage-1',
      stage,
      scenes,
      createdAt: '2026-08-30T00:00:00.000Z',
      // The generic storage guard would accept this minimum shape, but the
      // application boundary must reject it before it reaches a caller.
      coursePlan: { schemaVersion: 1, id: 'plan', courseId: 'course', version: 1 },
    });

    const response = await GET(new NextRequest('http://localhost/api/classroom?id=stage-1'));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'INTERNAL_ERROR',
    });
  });

  it.each(['../escape', 'stage/escape', '.', '..'])(
    'rejects unsafe classroom id %s',
    async (id) => {
      const { POST, GET } = await loadRoute();
      const post = await POST(requestWithBody({ stage: { ...stage, id }, scenes }));
      expect(post.status).toBe(400);
      expect(mocks.persistClassroom).not.toHaveBeenCalled();

      const get = await GET(
        new NextRequest(`http://localhost/api/classroom?id=${encodeURIComponent(id)}`),
      );
      expect(get.status).toBe(400);
      expect(mocks.readClassroom).not.toHaveBeenCalled();
    },
  );

  it('returns a client error for malformed JSON instead of a storage 500', async () => {
    const { POST } = await loadRoute();
    const request = new Request('http://localhost/api/classroom', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    }) as unknown as NextRequest;

    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(mocks.persistClassroom).not.toHaveBeenCalled();
  });

  it('deletes an existing classroom and returns a flat success body', async () => {
    const { DELETE } = await loadRoute();
    const response = await DELETE(
      new NextRequest('http://localhost/api/classroom?id=stage-1', { method: 'DELETE' }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, id: 'stage-1' });
    expect(mocks.deleteClassroom).toHaveBeenCalledExactlyOnceWith('stage-1');
    expect(mocks.sweepJobs).toHaveBeenCalledExactlyOnceWith('stage-1');
  });

  it('treats a missing classroom as a successful DELETE and GET then 404s', async () => {
    const { DELETE, GET } = await loadRoute();
    const deleted = await DELETE(
      new NextRequest('http://localhost/api/classroom?id=stage-gone', { method: 'DELETE' }),
    );
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({ success: true, id: 'stage-gone' });

    mocks.readClassroom.mockResolvedValueOnce(null);
    const get = await GET(new NextRequest('http://localhost/api/classroom?id=stage-gone'));
    expect(get.status).toBe(404);
    expect(mocks.readClassroom).toHaveBeenCalledWith('stage-gone');
  });

  it('is idempotent: a second DELETE is still 200', async () => {
    const { DELETE } = await loadRoute();
    const first = await DELETE(
      new NextRequest('http://localhost/api/classroom?id=stage-1', { method: 'DELETE' }),
    );
    const second = await DELETE(
      new NextRequest('http://localhost/api/classroom?id=stage-1', { method: 'DELETE' }),
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mocks.deleteClassroom).toHaveBeenCalledTimes(2);
  });

  it('rejects DELETE of the showcase classroom without touching storage', async () => {
    const { DELETE } = await loadRoute();
    const response = await DELETE(
      new NextRequest('http://localhost/api/classroom?id=fourier-intro', { method: 'DELETE' }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
      error: 'Showcase classroom cannot be deleted',
    });
    expect(mocks.deleteClassroom).not.toHaveBeenCalled();
    expect(mocks.sweepJobs).not.toHaveBeenCalled();
  });

  it('still returns 200 when job sweep fails', async () => {
    mocks.sweepJobs.mockRejectedValueOnce(new Error('sweep failed'));
    const { DELETE } = await loadRoute();
    const response = await DELETE(
      new NextRequest('http://localhost/api/classroom?id=stage-1', { method: 'DELETE' }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, id: 'stage-1' });
    expect(mocks.deleteClassroom).toHaveBeenCalledExactlyOnceWith('stage-1');
  });

  it.each(['../escape', 'stage/escape', '.', '..'])(
    'rejects unsafe DELETE classroom id %s',
    async (id) => {
      const { DELETE } = await loadRoute();
      const response = await DELETE(
        new NextRequest(`http://localhost/api/classroom?id=${encodeURIComponent(id)}`, {
          method: 'DELETE',
        }),
      );
      expect(response.status).toBe(400);
      expect(mocks.deleteClassroom).not.toHaveBeenCalled();
    },
  );

  it('returns 400 when DELETE is missing id', async () => {
    const { DELETE } = await loadRoute();
    const response = await DELETE(
      new NextRequest('http://localhost/api/classroom', { method: 'DELETE' }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      errorCode: 'MISSING_REQUIRED_FIELD',
    });
    expect(mocks.deleteClassroom).not.toHaveBeenCalled();
  });
});

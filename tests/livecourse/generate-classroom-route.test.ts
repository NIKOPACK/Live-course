import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  nanoid: vi.fn(),
  createClassroomGenerationJob: vi.fn(),
  runClassroomGenerationJob: vi.fn(),
  buildRequestOrigin: vi.fn(),
}));

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: mocks.after,
}));

vi.mock('nanoid', () => ({
  nanoid: mocks.nanoid,
}));

vi.mock('@/lib/server/classroom-job-store', () => ({
  createClassroomGenerationJob: mocks.createClassroomGenerationJob,
}));

vi.mock('@/lib/server/classroom-job-runner', () => ({
  runClassroomGenerationJob: mocks.runClassroomGenerationJob,
}));

vi.mock('@/lib/server/classroom-storage', () => ({
  buildRequestOrigin: mocks.buildRequestOrigin,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

async function postGenerateClassroom(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const { POST } = await import('@/app/api/generate-classroom/route');
  const request = new Request('http://localhost/api/generate-classroom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

describe('POST /api/generate-classroom', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.after.mockReset();
    mocks.nanoid.mockReset();
    mocks.createClassroomGenerationJob.mockReset();
    mocks.runClassroomGenerationJob.mockReset();
    mocks.buildRequestOrigin.mockReset();

    mocks.after.mockImplementation((callback: () => void) => callback());
    mocks.nanoid.mockReturnValue('job-123');
    mocks.createClassroomGenerationJob.mockResolvedValue({
      status: 'queued',
      step: 'queued',
      message: 'Classroom generation job queued',
    });
    mocks.runClassroomGenerationJob.mockResolvedValue(undefined);
    mocks.buildRequestOrigin.mockReturnValue('http://localhost');
  });

  it('passes only validated content and fixed server policy to storage and the runner', async () => {
    const pdfContent = {
      text: 'Course source',
      images: ['data:image/png;base64,abc'],
    };

    const response = await postGenerateClassroom({
      requirement: '  Teach introductory mechanics  ',
      pdfContent,
    });
    const json = await response.json();
    const expectedInput = {
      requirement: 'Teach introductory mechanics',
      pdfContent,
      enableWebSearch: false,
      enableImageGeneration: false,
      enableVideoGeneration: false,
      enableTTS: false,
      agentMode: 'default',
    };

    expect(response.status).toBe(202);
    expect(json).toMatchObject({
      success: true,
      jobId: 'job-123',
      status: 'queued',
      pollUrl: 'http://localhost/api/generate-classroom/job-123',
    });
    expect(mocks.createClassroomGenerationJob).toHaveBeenCalledWith('job-123', expectedInput);
    expect(mocks.runClassroomGenerationJob).toHaveBeenCalledWith(
      'job-123',
      expectedInput,
      'http://localhost',
    );
  });

  it('rejects a missing or blank requirement before creating a job', async () => {
    for (const body of [{}, { requirement: '   ' }]) {
      const response = await postGenerateClassroom(body);
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json).toMatchObject({
        success: false,
        errorCode: 'MISSING_REQUIRED_FIELD',
      });
    }

    expect(mocks.createClassroomGenerationJob).not.toHaveBeenCalled();
    expect(mocks.runClassroomGenerationJob).not.toHaveBeenCalled();
  });

  it('rejects malformed pdfContent before creating a job', async () => {
    const response = await postGenerateClassroom({
      requirement: 'Teach mechanics',
      pdfContent: { text: 'Source', images: [123] },
    });
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(mocks.createClassroomGenerationJob).not.toHaveBeenCalled();
    expect(mocks.runClassroomGenerationJob).not.toHaveBeenCalled();
  });

  it.each([
    ['webSearchApiKey', { webSearchApiKey: 'client-key' }],
    ['apiKey', { apiKey: 'client-key' }],
    ['providerId', { providerId: 'client-provider' }],
  ])('rejects the client body override %s before creating a job', async (_name, override) => {
    const response = await postGenerateClassroom({
      requirement: 'Teach mechanics',
      ...override,
    });
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(json.error).toContain('Only requirement and valid pdfContent fields are accepted');
    expect(mocks.createClassroomGenerationJob).not.toHaveBeenCalled();
    expect(mocks.runClassroomGenerationJob).not.toHaveBeenCalled();
  });

  it.each([
    ['X-Api-Key', 'client-key'],
    ['X-Model', 'client-model'],
    ['X-Provider-Type', 'openai'],
  ])('rejects the client credential header %s before creating a job', async (name, value) => {
    const response = await postGenerateClassroom(
      { requirement: 'Teach mechanics' },
      { [name]: value },
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(json.error).toContain('provider or credential header');
    expect(mocks.createClassroomGenerationJob).not.toHaveBeenCalled();
    expect(mocks.runClassroomGenerationJob).not.toHaveBeenCalled();
  });

  it('does not confuse an application authentication token with a provider credential', async () => {
    const response = await postGenerateClassroom(
      { requirement: 'Teach mechanics' },
      { Authorization: 'Bearer user-session-token' },
    );

    expect(response.status).toBe(202);
    expect(mocks.createClassroomGenerationJob).toHaveBeenCalledOnce();
  });

  it('returns 400 for malformed JSON before creating a job', async () => {
    const { POST } = await import('@/app/api/generate-classroom/route');
    const request = new Request('http://localhost/api/generate-classroom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });

    const response = await POST(request as unknown as NextRequest);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(mocks.createClassroomGenerationJob).not.toHaveBeenCalled();
    expect(mocks.runClassroomGenerationJob).not.toHaveBeenCalled();
  });

  it.each([
    ['enableWebSearch', true],
    ['enableImageGeneration', true],
    ['enableVideoGeneration', true],
    ['enableTTS', true],
    ['agentMode', 'generate'],
  ])('rejects the unsupported client control %s', async (name, value) => {
    const response = await postGenerateClassroom({
      requirement: 'Teach mechanics',
      [name]: value,
    });
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(json.error).toContain('Only requirement and valid pdfContent fields are accepted');
    expect(mocks.createClassroomGenerationJob).not.toHaveBeenCalled();
    expect(mocks.runClassroomGenerationJob).not.toHaveBeenCalled();
  });
});

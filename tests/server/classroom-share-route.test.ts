import { NextRequest } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { POST as createShare } from '@/app/api/classroom-shares/route';
import { GET as getShare } from '@/app/api/classroom-shares/[token]/route';
import { POST as redeemShare } from '@/app/api/classroom-shares/[token]/redeem/route';
import { DELETE as deleteClassroom } from '@/app/api/classroom/route';
import { CLASSROOM_SHARES_DIR } from '@/lib/server/classroom-share-storage';
import { CLASSROOMS_DIR } from '@/lib/server/classroom-storage';
import { htmlLessonPlan, htmlScene, htmlStage } from '../livecourse/share/fixtures';
import { buildShareSnapshot } from '@/lib/livecourse/share/build-snapshot';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
});

async function snapshotForm() {
  const { snapshot, files } = await buildShareSnapshot({
    token: `tok${Date.now()}abcdefghij`,
    stage: htmlStage(),
    scenes: [htmlScene('<img src="gen_img_1" alt="">')],
    lessonPlan: htmlLessonPlan(),
    resolveBytes: async () => new Blob([new Uint8Array([9, 8, 7])], { type: 'image/png' }),
  });
  const form = new FormData();
  form.set('snapshot', JSON.stringify(snapshot));
  for (const file of files) {
    form.set(file.path, file.blob, 'file.png');
  }
  return { snapshot, form };
}

function postRequest(form: FormData) {
  return new NextRequest('http://localhost/api/classroom-shares', {
    method: 'POST',
    body: form,
  });
}

describe('classroom share routes', () => {
  it('creates a snapshot, serves metadata, and redeems a new identity', async () => {
    const { snapshot, form } = await snapshotForm();
    created.push(path.join(CLASSROOM_SHARES_DIR, `${snapshot.token}.json`));
    created.push(path.join(CLASSROOM_SHARES_DIR, snapshot.token));

    const createdResponse = await createShare(postRequest(form));
    expect(createdResponse.status).toBe(201);
    const createdBody = (await createdResponse.json()) as { token: string; url: string };
    expect(createdBody.token).not.toBe(snapshot.token);
    expect(createdBody.token.length).toBeGreaterThanOrEqual(16);
    expect(createdBody.url).toContain(`/share/${createdBody.token}`);
    created.splice(0, created.length, path.join(CLASSROOM_SHARES_DIR, `${createdBody.token}.json`), path.join(CLASSROOM_SHARES_DIR, createdBody.token));

    const meta = await getShare(new NextRequest(`http://localhost/api/classroom-shares/${createdBody.token}`), {
      params: Promise.resolve({ token: createdBody.token }),
    });
    expect(meta.status).toBe(200);
    const metaBody = (await meta.json()) as { title: string };
    expect(metaBody.title).toBe('Shared Fourier');

    const redeemed = await redeemShare(
      new NextRequest(`http://localhost/api/classroom-shares/${createdBody.token}/redeem`, {
        method: 'POST',
      }),
      { params: Promise.resolve({ token: createdBody.token }) },
    );
    expect(redeemed.status).toBe(201);
    const redeemedBody = (await redeemed.json()) as {
      stageId: string;
      courseId: string;
      classroom: { stage: { id: string }; lessonPlan: { courseId: string } };
    };
    created.push(path.join(CLASSROOMS_DIR, `${redeemedBody.stageId}.json`));
    created.push(path.join(CLASSROOMS_DIR, redeemedBody.stageId));
    expect(redeemedBody.stageId).toMatch(/^stage-/);
    expect(redeemedBody.stageId).not.toBe('stage-AAA');
    expect(redeemedBody.classroom.lessonPlan.courseId).toBe(redeemedBody.courseId);
  });

  it('rejects leftover placeholder HTML with 400', async () => {
    const { snapshot, form } = await snapshotForm();
    const parsed = JSON.parse(form.get('snapshot') as string) as {
      scenes: Array<{ content: { html: string } }>;
    };
    parsed.scenes[0].content.html = '<img src="gen_img_1" alt="">';
    form.set('snapshot', JSON.stringify({ ...snapshot, scenes: parsed.scenes }));
    const response = await createShare(postRequest(form));
    expect(response.status).toBe(400);
  });

  it('does not delete share snapshots when a classroom is deleted', async () => {
    const { snapshot, form } = await snapshotForm();
    const createdResponse = await createShare(postRequest(form));
    const createdBody = (await createdResponse.json()) as { token: string };
    created.push(path.join(CLASSROOM_SHARES_DIR, `${createdBody.token}.json`));
    created.push(path.join(CLASSROOM_SHARES_DIR, createdBody.token));

    const deleted = await deleteClassroom(
      new NextRequest(`http://localhost/api/classroom?id=${snapshot.sourceStageId}`, {
        method: 'DELETE',
      }),
    );
    expect(deleted.status).toBe(200);
    const shareFile = await fs.readFile(path.join(CLASSROOM_SHARES_DIR, `${createdBody.token}.json`), 'utf-8');
    expect(shareFile).toContain(createdBody.token);
  });

  it('returns 404 for an unknown token', async () => {
    const response = await getShare(new NextRequest('http://localhost/api/classroom-shares/unknown-token-zzzz'), {
      params: Promise.resolve({ token: 'unknown-token-zzzz' }),
    });
    expect(response.status).toBe(404);
  });
});

import { test, expect } from '../fixtures/base';

/**
 * Teaching-loop E2E (A-011). Drives a real Chromium through the visible
 * classroom UI and the controlled agent-session server APIs — no domain
 * imports, no page evaluation of domain records, no test-only routes.
 *
 * The classroom is persisted through the real POST /api/classroom product
 * API so the server-owned ClassroomAgentSession can resolve the lesson scope
 * from the server classroom store. The panel is the normal classroom UI
 * integration: it only calls the controlled server APIs.
 */
const TEST_STAGE_ID = 'e2e-teaching-loop';

const SCENE_TITLES = ['引言', '第一课核心', '收尾与第二课'];

// The two tests share one server-side classroom document and one dev-server
// session store keyed by (classroom, learner); serial mode keeps the shared
// file writes deterministic.
test.describe.configure({ mode: 'serial' });

function classroomDocument() {
  const now = Date.now();
  const stage = {
    id: TEST_STAGE_ID,
    name: '教学闭环验证课程',
    description: '两课时教学闭环端到端验证',
    language: 'zh-CN',
    style: 'professional',
    createdAt: now,
    updatedAt: now,
  };
  const scenes = SCENE_TITLES.map((title, index) => ({
    id: `scene-${index}`,
    stageId: TEST_STAGE_ID,
    type: 'slide',
    title,
    order: index,
    content: {
      type: 'slide',
      canvas: {
        id: `slide-${index}`,
        viewportSize: 1000,
        viewportRatio: 0.5625,
        theme: {
          colors: { background: '#ffffff', primary: '#4f46e5' },
          font: { family: 'Inter', scale: 1 },
        },
        elements: [
          {
            type: 'text',
            id: `el-${index}`,
            content: title,
            left: 50,
            top: 50,
            width: 900,
            height: 100,
          },
        ],
      },
    },
    createdAt: now,
    updatedAt: now,
  }));
  return { stage, scenes };
}

/** Persist the classroom through the real product API so the server store knows it. */
async function persistClassroom(page: import('@playwright/test').Page) {
  const { stage, scenes } = classroomDocument();
  const response = await page.request.post('/api/classroom', { data: { stage, scenes } });
  expect(response.ok(), `persist classroom via POST /api/classroom (${response.status()})`).toBe(
    true,
  );
}

function panel(page: import('@playwright/test').Page) {
  return page.getByTestId('teaching-loop-panel');
}

/** Expand the teaching-loop panel (it collapses by default to keep the scene navigator usable). */
async function expandPanel(page: import('@playwright/test').Page) {
  await page.getByTestId('teaching-loop-toggle').click();
}

async function openClassroom(page: import('@playwright/test').Page) {
  await page.goto(`/classroom/${TEST_STAGE_ID}`, { waitUntil: 'domcontentloaded' });
  await expect(panel(page)).toBeVisible({ timeout: 30_000 });
  // The panel collapses by default so it never blocks the scene navigator;
  // expand it before driving the teaching-loop controls.
  await expandPanel(page);
  await expect(page.getByTestId('tl-session-state')).toHaveText('会话就绪', {
    timeout: 30_000,
  });
  // A brand-new classroom session must never claim it was restored; only a
  // real reload/re-establishment of an existing server binding may show the
  // recovery marker (see the reload steps below).
  await expect(page.getByTestId('tl-restored')).toHaveCount(0);
}

test('agent session fails assistant work explicitly and recovers with the opaque cookie', async ({
  page,
}) => {
  await persistClassroom(page);
  await openClassroom(page);

  // Server-owned identity is displayed, never client-declared.
  await expect(page.getByTestId('tl-teacher-agent')).toContainText('realtime-teacher:');
  await expect(page.getByTestId('tl-session-id')).toContainText('会话 ');
  const rosterRows = page.getByTestId('tl-roster').locator('li');
  await expect(rosterRows).toHaveCount(3);

  // No test/demo executor is wired into production. Delegation must fail
  // visibly instead of echoing the input as a fake successful proposal.
  await page.getByTestId('tl-delegate-kind').selectOption('draft_board_note');
  await page.getByTestId('tl-delegate-refs').fill('note:第一课板书要点');
  await page.getByTestId('tl-delegate-submit').click();

  const boardNoteRow = panel(page)
    .locator('[data-testid^="tl-task-"]')
    .filter({ hasText: 'draft_board_note' });
  await expect(boardNoteRow).toHaveCount(1, { timeout: 20_000 });
  await expect(boardNoteRow.getByTestId('tl-task-status')).toHaveText('失败', {
    timeout: 20_000,
  });
  await expect(boardNoteRow.getByTestId('tl-task-failure')).toContainText('not configured');
  await expect(boardNoteRow.locator('[data-testid^="tl-confirm-"]')).toHaveCount(0);

  // Reload keeps the opaque cookie and may resume the same in-process session.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('tl-session-state')).toHaveText('会话就绪', {
    timeout: 30_000,
  });
  await expandPanel(page);
  await expect(page.getByTestId('tl-restored')).toBeVisible({ timeout: 30_000 });
  await expect(boardNoteRow.getByTestId('tl-task-status')).toHaveText('失败');
});

test('forged and missing sessions fail closed without a false completed display', async ({
  page,
}) => {
  await persistClassroom(page);
  await openClassroom(page);

  // Create one terminal task so stale session state exists to be suppressed.
  await page.getByTestId('tl-delegate-kind').selectOption('draft_board_note');
  await page.getByTestId('tl-delegate-refs').fill('note:安全验证要点');
  await page.getByTestId('tl-delegate-submit').click();
  const row = panel(page)
    .locator('[data-testid^="tl-task-"]')
    .filter({ hasText: 'draft_board_note' });
  await expect(row.getByTestId('tl-task-status')).toHaveText('失败', { timeout: 20_000 });

  // ── Forged token through the real API: explicit rejection ──
  const forged = await page.request.post('/api/livecourse/agent-session/tasks', {
    headers: { cookie: 'lc-agent-session=forged-token-value' },
    data: { assistantId: 'assistant-forged', kind: 'draft_board_note', inputRefs: ['note:x'] },
  });
  expect(forged.status()).toBe(401);
  const forgedBody = (await forged.json()) as { error?: { code?: string } };
  expect(forgedBody.error?.code).toBe('SESSION_MISSING');

  // ── Expired/missing session through the visible UI: fail closed ──
  await page.context().clearCookies();
  await expect(page.getByTestId('tl-session-state')).toHaveText('会话失效', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('tl-session-failed')).toBeVisible();
  await expect(page.getByTestId('tl-tasks-empty')).toBeVisible();
  await expect(panel(page)).not.toContainText('失败');
  // No completed/any task rows are displayed after the session fails.
  await expect(panel(page).locator('[data-testid^="tl-task-"]')).toHaveCount(0);

  // Without the opaque credential, a guessed learner id cannot recover the
  // existing session after reload.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('tl-session-state')).toHaveText('会话失效', {
    timeout: 30_000,
  });
  await expandPanel(page);
  await expect(page.getByTestId('tl-restored')).toHaveCount(0);
  await expect(panel(page).locator('[data-testid^="tl-task-"]')).toHaveCount(0);
});

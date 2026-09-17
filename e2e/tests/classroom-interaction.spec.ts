import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';

const TEST_STAGE_ID = 'e2e-test-stage';

const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

/** Seed IndexedDB with stage + 3 scenes using raw IndexedDB API */
async function seedDatabase(page: import('@playwright/test').Page) {
  // Inject settings before navigating so it's available immediately on load
  await page.addInitScript((settings) => {
    localStorage.setItem('livecourse:account:settings-storage', settings);
    localStorage.setItem('locale', 'en-US');
  }, SETTINGS_STORAGE);

  // Navigate to home page first — this causes Dexie to open/create the DB at v8
  // with the correct schema. We wait for network idle to ensure Dexie is done.
  await page.goto('/', { waitUntil: 'networkidle' });

  // Now seed data by opening the DB at its current version (no upgrade).
  // Opening without a version number returns the current version without triggering
  // onupgradeneeded, so we can safely write to the already-initialized schema.
  const seedStageData = () =>
    page.evaluate(
      ({ stageId }) => {
        return new Promise<void>((resolve, reject) => {
          // Open without specifying version — uses current DB version, no upgrade event
          const request = indexedDB.open('LiveCourse-Database');

          request.onsuccess = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;
            const tx = db.transaction(['stages', 'scenes', 'stageOutlines'], 'readwrite');
            const now = Date.now();

            tx.objectStore('stages').put({
              id: stageId,
              name: '光合作用',
              description: '',
              language: 'zh-CN',
              style: 'professional',
              createdAt: now,
              updatedAt: now,
            });

            const makeHtmlPage = (title: string, elId: string) => ({
              type: 'interactive',
              url: '',
              html: `<!DOCTYPE html><html><head></head><body><main id="teach-${elId}">${title}</main></body></html>`,
            });

            const scenes = [
              {
                id: 'scene-0',
                stageId,
                type: 'interactive',
                title: '基本概念',
                order: 0,
                content: makeHtmlPage('基本概念', '0'),
                createdAt: now,
                updatedAt: now,
              },
              {
                id: 'scene-1',
                stageId,
                type: 'interactive',
                title: '光反应',
                order: 1,
                content: makeHtmlPage('光反应', '1'),
                createdAt: now,
                updatedAt: now,
              },
              {
                id: 'scene-2',
                stageId,
                type: 'interactive',
                title: '暗反应',
                order: 2,
                content: makeHtmlPage('暗反应', '2'),
                createdAt: now,
                updatedAt: now,
              },
            ];
            for (const scene of scenes) {
              tx.objectStore('scenes').put(scene);
            }

            tx.objectStore('stageOutlines').put({
              stageId,
              outlines: [],
              lessonPlan: {
                schemaVersion: 1,
                id: `lesson-plan:${stageId}`,
                courseId: stageId,
                stageId,
                title: '光合作用',
                version: 1,
                status: 'approved',
                createdAt: new Date(now).toISOString(),
                goals: [],
                nodes: [],
                presentation: { mode: 'html', visualStyle: 'Test classroom direction.' },
              },
              createdAt: now,
              updatedAt: now,
            });

            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };

          request.onerror = () => reject(request.error);
        });
      },
      { stageId: TEST_STAGE_ID },
    );

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await seedStageData();
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('Execution context was destroyed') || attempt === 2) {
        throw error;
      }
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(250);
    }
  }
}

test.describe('Classroom Interaction', () => {
  test.beforeEach(async ({ page }) => {
    await seedDatabase(page);
  });

  test('loads classroom as a board and lectern, not a player', async ({ page }) => {
    const classroom = new ClassroomPage(page);
    await classroom.goto(TEST_STAGE_ID);
    await classroom.waitForLoaded();

    await expect(classroom.shell).toBeVisible({ timeout: 10_000 });
    await expect(classroom.board).toBeVisible();
    await expect(classroom.sidebarScenes).toHaveCount(0);
    await expect(page.getByTestId('roundtable-non-presentation-card')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '光反应' })).toHaveCount(0);
  });
});

import { test, expect } from '../fixtures/base';
import { HomePage } from '../pages/home.page';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';

const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: false });

test.describe('Full Happy Path', () => {
  test.beforeEach(async ({ page, mockApi }) => {
    // Pre-seed settings in localStorage (all tests do this)
    await page.addInitScript((settings) => {
      localStorage.setItem('livecourse:account:settings-storage', settings);
    }, SETTINGS_STORAGE);

    // Set up generation API mocks BEFORE any navigation —
    // generation auto-starts when generation-preview mounts.
    await mockApi.setupGenerationMocks();
  });

  test('home → generation-preview → classroom with scene navigation', async ({ page }) => {
    // ── Phase 1: Home page ──────────────────────────────────────────────
    const home = new HomePage(page);
    await home.goto();

    // Core UI elements visible
    await expect(home.logo).toBeVisible();
    await expect(home.textarea).toBeVisible();
    await expect(home.enterButton).toBeDisabled();

    // Fill requirement text → submit button activates
    await home.fillRequirement('讲解光合作用');
    await expect(home.enterButton).toBeEnabled();

    // Submit → navigate to generation-preview
    await home.submit();
    await page.waitForURL(/\/generation-preview/);

    // ── Phase 2: Generation preview ─────────────────────────────────────
    const preview = new GenerationPreviewPage(page);

    // Generation progress UI should be visible
    await expect(preview.stepTitle).toBeVisible();

    // Wait for mocked generation to complete, then enter classroom explicitly
    await preview.waitForRedirectToClassroom();
    expect(page.url()).toMatch(/\/classroom\//);

    // ── Phase 3: Classroom ──────────────────────────────────────────────
    const classroom = new ClassroomPage(page);
    await classroom.waitForLoaded();

    await expect(classroom.shell).toBeVisible({ timeout: 10_000 });
    await expect(classroom.board).toBeVisible();
    await expect(classroom.sidebarScenes).toHaveCount(0);
  });
});

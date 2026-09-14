import { test, expect } from '../fixtures/base';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';

const SETTINGS_STORAGE = createSettingsStorage();

const GENERATION_SESSION = JSON.stringify({
  sessionId: 'e2e-test-session',
  requirements: {
    requirement: '讲解光合作用',
    language: 'zh-CN',
  },
  pdfText: '',
  pdfImages: [],
  imageStorageIds: [],
  sceneOutlines: null,
  currentStep: 'generating',
});

// SSE generation + IndexedDB seeding against one shared dev server is flaky
// under intra-file parallelism (same remedy as model-invariant-580): run the
// generation specs serially.
test.describe.configure({ mode: 'serial' });
test.setTimeout(60_000);

test.describe('Generation Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ settings, session }) => {
        localStorage.setItem('livecourse:account:settings-storage', settings);
        sessionStorage.setItem('generationSession', session);
      },
      { settings: SETTINGS_STORAGE, session: GENERATION_SESSION },
    );
  });

  test('completes generation pipeline and waits for explicit enter classroom', async ({
    page,
    mockApi,
  }) => {
    // Set up all API mocks
    await mockApi.setupGenerationMocks();

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    // Preparation state remains visible until the explicit entry action.
    await expect(preview.stepTitle).toBeVisible();

    await preview.waitForEnterClassroom();
    await expect(page).toHaveURL(/\/generation-preview/);
    await expect(preview.enterClassroomButton).toBeEnabled();
    await expect(preview.segments).toHaveCount(3);
    await expect(page.getByTestId('retry-segment')).toHaveCount(0);
    await preview.segments.first().getByTestId('preview-segment-toggle').click();
    await expect(page.getByTestId('segment-classroom-preview').first()).toBeVisible();
    await preview.enterClassroom();
    await page.waitForURL(/\/classroom\//, { timeout: 30_000 });
    expect(page.url()).toMatch(/\/classroom\//);
  });

  test('answers in-preview clarification questions before lesson plan design', async ({
    page,
    mockApi,
  }) => {
    await mockApi.mockClarifyQuestions();
    await mockApi.mockKnowledgeMapEmpty();
    await mockApi.mockSceneOutlinesStream();
    await mockApi.mockSceneContent();
    await mockApi.mockSceneActions();

    const preview = new GenerationPreviewPage(page);
    await preview.goto();

    // Clarification card shows inside the preview page (before outline/lesson
    // plan generation); answer one option and continue.
    const option = page.getByRole('button', { name: '零基础入门' });
    await option.waitFor({ state: 'visible' });
    await expect(preview.enterClassroomButton).toHaveCount(0);
    await expect(page.getByRole('button', { name: /开始上课|Start class/ })).toHaveCount(0);
    await option.click();
    await page.getByRole('button', { name: /^(继续|Continue)$/ }).click();

    // Generation proceeds; entering classroom is an explicit action.
    await preview.waitForEnterClassroom();
    await expect(page).toHaveURL(/\/generation-preview/);
    await preview.enterClassroom();
    await page.waitForURL(/\/classroom\//, { timeout: 30_000 });
    expect(page.url()).toMatch(/\/classroom\//);
  });
});

import type { Page, Locator } from '@playwright/test';

export class GenerationPreviewPage {
  readonly page: Page;
  readonly stepTitle: Locator;
  readonly backButton: Locator;
  readonly enterClassroomButton: Locator;
  readonly segments: Locator;

  constructor(page: Page) {
    this.page = page;
    this.stepTitle = page.locator('h2').first();
    this.backButton = page.getByRole('button', { name: /back|返回/i });
    this.enterClassroomButton = page.getByTestId('enter-classroom');
    this.segments = page.getByTestId('preview-segment');
  }

  async goto() {
    await this.page.goto('/generation-preview');
  }

  async waitForRedirectToClassroom() {
    await this.enterClassroom();
    await this.page.waitForURL(/\/classroom\//, { timeout: 30_000 });
  }

  async waitForEnterClassroom() {
    await this.enterClassroomButton.waitFor({ state: 'visible', timeout: 30_000 });
  }

  async enterClassroom() {
    await this.waitForEnterClassroom();
    await this.enterClassroomButton.click();
  }
}

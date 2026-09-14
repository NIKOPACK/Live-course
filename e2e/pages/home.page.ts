import type { Page, Locator } from '@playwright/test';

export class HomePage {
  readonly page: Page;
  readonly logo: Locator;
  readonly textarea: Locator;
  readonly enterButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.logo = page.getByLabel('LiveCourse').first();
    this.textarea = page.locator('textarea');
    // Prefer the stable testid; keep the historical text locators as fallbacks
    // so the page object survives copy/localization tweaks.
    this.enterButton = page
      .getByTestId('start-generation')
      .or(page.getByRole('button', { name: /enter classroom|create course/i }))
      .or(page.locator('button:has-text("进入课堂"), button:has-text("创建课程")'));
  }

  async goto() {
    await this.page.goto('/');
  }

  async fillRequirement(text: string) {
    await this.textarea.fill(text);
  }

  async submit() {
    await this.enterButton.click();
  }
}

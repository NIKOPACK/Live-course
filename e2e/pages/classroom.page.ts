import type { Page, Locator } from '@playwright/test';

export class ClassroomPage {
  readonly page: Page;
  readonly loadingText: Locator;
  readonly shell: Locator;
  readonly board: Locator;
  readonly teacher: Locator;
  readonly sessionBar: Locator;
  /** Legacy playlist locator — classroom chrome must not render these. */
  readonly sidebarScenes: Locator;

  constructor(page: Page) {
    this.page = page;
    this.loadingText = page.getByText('Loading classroom...');
    this.shell = page.getByTestId('classroom-shell');
    this.board = page.getByTestId('classroom-board');
    this.teacher = page.getByTestId('classroom-teacher');
    this.sessionBar = page.getByTestId('classroom-session-bar');
    this.sidebarScenes = page.locator('[data-testid="scene-item"]');
  }

  async goto(stageId: string) {
    await this.page.goto(`/classroom/${stageId}`);
  }

  async waitForLoaded() {
    await this.loadingText.waitFor({ state: 'hidden', timeout: 15_000 });
    await this.shell.waitFor({ state: 'visible', timeout: 15_000 });
  }

  async clickScene(index: number) {
    await this.sidebarScenes.nth(index).click();
  }

  /** Get scene title — it's the second span (first is the number badge) */
  getSceneTitle(index: number) {
    return this.sidebarScenes.nth(index).locator('[data-testid="scene-title"]');
  }
}

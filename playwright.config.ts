import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'html' : 'list',
  use: {
    baseURL: 'http://localhost:3002',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: process.env.CI ? 'pnpm start' : 'pnpm dev',
    url: 'http://localhost:3002',
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    // Enable the LiveCourse Editor (Pro mode) so editor e2e can reach it. This is a
    // build-time NEXT_PUBLIC_* flag. CI injects it in the explicit build step;
    // local development receives it through this webServer environment.
    env: { PORT: '3002', NEXT_PUBLIC_LIVECOURSE_EDITOR_ENABLED: 'true' },
  },
});

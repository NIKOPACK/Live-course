import type { Page } from '@playwright/test';
import type { SceneOutline } from '../../lib/types/generation';
import { mockOutlines } from './test-data/scene-outlines';
import {
  createMockSceneContentResponse,
  mockSceneContentResponse,
} from './test-data/scene-content';
import { createMockSceneActionsResponse } from './test-data/scene-actions';

/**
 * Wraps Playwright's page.route() to mock LiveCourse API endpoints.
 * Supports both JSON and SSE (text/event-stream) responses.
 */
export class MockApi {
  constructor(private page: Page) {}

  /** Mock the SSE outline streaming endpoint */
  async mockSceneOutlinesStream(outlines = mockOutlines) {
    await this.page.route('**/api/generate/scene-outlines-stream', (route) => {
      const events = outlines
        .map(
          (outline, i) =>
            `data: ${JSON.stringify({ type: 'outline', data: outline, index: i })}\n\n`,
        )
        .join('');
      const done = `data: ${JSON.stringify({ type: 'done', outlines, courseTitle: 'Mock Course' })}\n\n`;

      route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
        body: events + done,
      });
    });
  }

  /** Mock the scene content generation endpoint */
  async mockSceneContent(response?: typeof mockSceneContentResponse) {
    await this.page.route('**/api/generate/scene-content', (route) => {
      const body = route.request().postDataJSON() as { outline?: SceneOutline } | null;
      const payload = response ?? createMockSceneContentResponse(body?.outline);

      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    });
  }

  /** Mock the scene actions generation endpoint.
   *  When no stageId is provided, it is extracted from the request body
   *  so the mock response matches the dynamically-generated stage id. */
  async mockSceneActions(stageId?: string) {
    await this.page.route('**/api/generate/scene-actions', async (route) => {
      let id = stageId ?? 'test-stage';
      let outline: SceneOutline | undefined;
      if (!stageId) {
        try {
          const body = route.request().postDataJSON() as {
            stageId?: string;
            outline?: SceneOutline;
          };
          if (body?.stageId) id = body.stageId;
          outline = body?.outline;
        } catch {
          // fallback to default
        }
      }
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createMockSceneActionsResponse(id, outline)),
      });
    });
  }

  /** Mock the clarify endpoint as "ready" so legacy generation-flow tests keep
   *  the old path (no clarification card / scope picker in the way). */
  async mockClarifyReady() {
    await this.page.route('**/api/generate/outline/clarify', (route) => {
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ready' }),
      });
    });
  }

  /** Mock the clarify endpoint with questions (A3 in-preview confirmation). */
  async mockClarifyQuestions() {
    await this.page.route('**/api/generate/outline/clarify', (route) => {
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'needs_clarification',
          questions: [
            {
              id: 'q1',
              question: '你的目标是什么？',
              multiSelect: false,
              options: [
                { id: 'beginner', label: '零基础入门' },
                { id: 'exam', label: '备考复习' },
              ],
            },
          ],
        }),
      });
    });
  }

  /** Mock the knowledge-map endpoint with an empty tree (scope step skipped). */
  async mockKnowledgeMapEmpty() {
    await this.page.route('**/api/generate/outline/knowledge-map', (route) => {
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: 'Mock', topics: [] }),
      });
    });
  }

  /** Mock the server providers endpoint (returns empty — client-side config only) */
  async mockServerProviders() {
    await this.page.route('**/api/server-providers', (route) => {
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: {} }),
      });
    });
  }

  /** Set up API mocks for the generation flow. Note: server-providers is already mocked by the base fixture. */
  async setupGenerationMocks(stageId?: string) {
    await this.mockClarifyReady();
    await this.mockSceneOutlinesStream();
    await this.mockSceneContent();
    await this.mockSceneActions(stageId);
  }
}

// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClarifyQuestion, KnowledgeMap } from '@/lib/livecourse/outline/types';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${JSON.stringify(values)}` : key,
  }),
}));

vi.mock('@/components/slide-renderer/SlideThumbnail', () => ({
  SlideThumbnail: () => createElement('div', { 'data-testid': 'slide-thumbnail' }),
}));

import { ClarifyCard } from '@/components/generation/clarify-card';
import { ScopePicker } from '@/components/generation/scope-picker';
import { SegmentList } from '@/app/generation-preview/components/segment-list';
import type { SegmentProgress } from '@/app/generation-preview/segment-status';
import { SegmentClassroomPreview } from '@/app/generation-preview/components/segment-classroom-preview';
import { LessonPlanPanel } from '@/app/generation-preview/components/lesson-plan-panel';
import { ConfirmationFailurePanel } from '@/app/generation-preview/components/confirmation-failure';
import type { LessonPlan } from '@/lib/livecourse/domain/schemas';
import type { Scene } from '@/lib/types/stage';

const questions: ClarifyQuestion[] = [
  {
    id: 'goal',
    question: 'What is your goal?',
    multiSelect: false,
    options: [
      {
        id: 'understand',
        label:
          'Understand the ideas through detailed explanations and practical examples that connect to situations I already know',
      },
      { id: 'exam', label: 'Prepare for an exam' },
    ],
  },
  {
    id: 'scope',
    question: 'Which topics interest you?',
    multiSelect: true,
    options: [
      { id: 'motion', label: 'Motion' },
      { id: 'energy', label: 'Energy' },
    ],
  },
  {
    id: 'pace',
    question: 'What pace works for this lesson?',
    multiSelect: false,
    options: [
      { id: 'slow', label: 'Explain each step slowly' },
      { id: 'fast', label: 'A quick overview' },
    ],
  },
];

const knowledgeMap: KnowledgeMap = {
  subject: 'Physics',
  topics: [
    {
      id: 'mechanics',
      title: 'Mechanics',
      recommended: false,
      children: [
        { id: 'motion', title: 'Motion and forces', recommended: true },
        {
          id: 'energy',
          title:
            'Conservation of energy through a sequence of connected systems with detailed worked examples',
          recommended: false,
        },
      ],
    },
  ],
};
const customTitle = knowledgeMap.topics[0].children![1].title;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  class ResizeObserverMock {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback(
        [{ target, contentRect: { width: 320, height: 180 } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(element: ReactElement) {
  await act(async () => root.render(element));
}
function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(
    (element) => element.textContent === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
function checkbox(title: string): HTMLButtonElement {
  const result = [...container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')].find(
    (element) => element.getAttribute('aria-label') === title,
  );
  if (!result) throw new Error(`Missing checkbox: ${title}`);
  return result;
}
async function click(element: HTMLButtonElement) {
  await act(async () => element.click());
}
function assertReadOnly(root: ParentNode = container) {
  expect(root.querySelector('input, textarea, select, [contenteditable="true"]')).toBeNull();
}

it('retains automatic segment expansion after completion and respects manual closure on retries', async () => {
  const first: SegmentProgress = {
    outlineId: 'first',
    title: 'First',
    order: 0,
    status: 'generating',
  };
  const show = (segments: SegmentProgress[]) =>
    render(createElement(SegmentList, { segments, onRetry: vi.fn(), retryingId: null }));
  const toggles = () => [
    ...container.querySelectorAll<HTMLButtonElement>('[data-testid="preview-segment-toggle"]'),
  ];
  await show([first]);
  expect(toggles()[0].getAttribute('aria-expanded')).toBe('true');
  await show([{ ...first, status: 'completed' }]);
  expect(toggles()[0].getAttribute('aria-expanded')).toBe('true');
  await click(toggles()[0]);
  await show([first]);
  expect(toggles()[0].getAttribute('aria-expanded')).toBe('false');
  await show([
    { ...first, status: 'completed' },
    { ...first, outlineId: 'second', title: 'Second', order: 1 },
  ]);
  expect(toggles().map((toggle) => toggle.getAttribute('aria-expanded'))).toEqual([
    'false',
    'true',
  ]);
});

it('disables failed-segment retry while the generation worker is still running', async () => {
  const onRetry = vi.fn();
  const segments: SegmentProgress[] = [
    { outlineId: 'failed', title: 'Failed', order: 0, status: 'failed' },
    { outlineId: 'active', title: 'Active', order: 1, status: 'generating' },
  ];
  await render(
    createElement(SegmentList, { segments, onRetry, retryingId: null, generationBusy: true }),
  );
  const retry = container.querySelector<HTMLButtonElement>('[data-testid="retry-segment"]')!;
  expect(retry.disabled).toBe(true);
  await click(retry);
  expect(onRetry).not.toHaveBeenCalled();
  await render(
    createElement(SegmentList, { segments, onRetry, retryingId: null, generationBusy: false }),
  );
  expect(retry.disabled).toBe(false);
  await click(retry);
  expect(onRetry).toHaveBeenCalledWith('failed');
});

// docs/spec/01 J2.0: step-local choices; only the final action crosses the
// existing onContinue/onSkip boundary. Neither component writes W/C/L.
describe('ClarifyCard sequential answers', () => {
  it('renders one question and progress, focuses each question, and keeps intermediate answers local', async () => {
    const onContinue = vi.fn();
    const onSkip = vi.fn();
    await render(createElement(ClarifyCard, { questions, onContinue, onSkip }));
    expect(container.querySelectorAll('h3')).toHaveLength(1);
    expect(document.activeElement?.textContent).toBe(questions[0].question);
    expect(container.textContent).not.toContain(questions[1].question);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      '"current":1,"total":3',
    );
    expect(button('clarify.continue').disabled).toBe(true);
    await click(button(questions[0].options[0].label));
    expect(button(questions[0].options[0].label).getAttribute('aria-pressed')).toBe('true');
    await click(button('clarify.continue'));
    expect(document.activeElement?.textContent).toBe(questions[1].question);
    expect(container.textContent).not.toContain(questions[0].question);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      '"current":2,"total":3',
    );
    expect(onContinue).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('skips only the current question and retains previous and later answers', async () => {
    const onContinue = vi.fn();
    await render(createElement(ClarifyCard, { questions, onContinue, onSkip: vi.fn() }));
    await click(button('Prepare for an exam'));
    await click(button('clarify.continue'));
    await click(button('Motion'));
    await click(button('Energy'));
    await click(button('clarify.skipCurrent'));
    await click(button('Explain each step slowly'));
    await click(button('clarify.continue'));
    expect(onContinue).toHaveBeenCalledOnce();
    expect(onContinue.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        questionId: 'goal',
        selectedOptionIds: ['exam'],
        selectedLabels: ['Prepare for an exam'],
      }),
      expect.objectContaining({ questionId: 'scope', selectedOptionIds: [], selectedLabels: [] }),
      expect.objectContaining({
        questionId: 'pace',
        selectedOptionIds: ['slow'],
        selectedLabels: ['Explain each step slowly'],
      }),
    ]);
  });

  it('skips remaining questions without discarding earlier or current multi-select answers', async () => {
    const onContinue = vi.fn();
    const onSkip = vi.fn();
    await render(createElement(ClarifyCard, { questions, onContinue, onSkip }));
    await click(button('Prepare for an exam'));
    await click(button('clarify.continue'));
    await click(button('Motion'));
    await click(button('Energy'));
    expect(container.textContent).toContain('preparationVisual.answersKept');
    await click(button('clarify.skipRemaining'));
    expect(onSkip).not.toHaveBeenCalled();
    expect(onContinue.mock.calls[0][0]).toEqual([
      expect.objectContaining({ questionId: 'goal', selectedOptionIds: ['exam'] }),
      expect.objectContaining({ questionId: 'scope', selectedOptionIds: ['motion', 'energy'] }),
      expect.objectContaining({ questionId: 'pace', selectedOptionIds: [] }),
    ]);
  });

  it('allows skipping all questions without inventing answers', async () => {
    const onContinue = vi.fn();
    const onSkip = vi.fn();
    await render(createElement(ClarifyCard, { questions, onContinue, onSkip }));
    await click(button('clarify.skipAll'));
    expect(onSkip).toHaveBeenCalledOnce();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('submits the last answer once even for two clicks before React commits', async () => {
    const onContinue = vi.fn();
    await render(
      createElement(ClarifyCard, { questions: questions.slice(0, 1), onContinue, onSkip: vi.fn() }),
    );
    await click(button('Prepare for an exam'));
    const submit = button('clarify.continue');
    await act(async () => {
      submit.click();
      submit.click();
    });
    expect(onContinue).toHaveBeenCalledOnce();
    expect([...container.querySelectorAll('button')].every((element) => element.disabled)).toBe(
      true,
    );
  });

  it('disables answers and all navigation while submitting', async () => {
    const onContinue = vi.fn();
    const onSkip = vi.fn();
    await render(createElement(ClarifyCard, { questions, submitting: true, onContinue, onSkip }));
    expect([...container.querySelectorAll('button')].every((element) => element.disabled)).toBe(
      true,
    );
    await click(button('clarify.skipAll'));
    expect(onSkip).not.toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('keeps long questions, options and help readable in one untruncated workspace', async () => {
    const question = '课程目标'.repeat(80);
    const label = 'A-long-unbroken-option-'.repeat(40);
    const description = 'Helpful context for this choice. '.repeat(20);
    await render(
      createElement(ClarifyCard, {
        questions: [
          {
            ...questions[0],
            question,
            options: [{ id: 'long', label, description }],
          },
        ],
        onContinue: vi.fn(),
        onSkip: vi.fn(),
      }),
    );

    expect(container.querySelector('h3')?.textContent).toBe(question);
    const option = container.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
    expect(option.textContent).toContain(label);
    expect(option.textContent).toContain(description);
    expect(option.className).toContain('whitespace-normal');
    expect(option.className).toContain('min-w-0');
    expect(container.firstElementChild?.className).toContain('[overflow-wrap:anywhere]');
    expect(container.innerHTML).not.toMatch(/truncate|line-clamp|text-xs/);
    for (const action of container.querySelectorAll('button')) {
      expect(action.className).toContain('min-h-11');
    }
    expect(container.querySelector('progress')).toBeNull();
  });
});

// docs/spec/01 J2.0b: a loaded map owns both the current selection and cached
// recommendations; a failed submission rerenders that same picker.
describe('ScopePicker confirmation and recovery', () => {
  it('preselects recommendations, blocks empty scope, and directly submits cached recommendations', async () => {
    const onStart = vi.fn();
    const onSkip = vi.fn();
    await render(createElement(ScopePicker, { knowledgeMap, onStart, onSkip }));
    expect(checkbox('Motion and forces').getAttribute('aria-checked')).toBe('true');
    await click(checkbox('Motion and forces'));
    expect(button('clarify.startClass').disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('clarify.emptySelection');
    await click(button('clarify.startClass'));
    expect(onStart).not.toHaveBeenCalled();
    await click(checkbox(customTitle));
    await click(button('clarify.skipScope'));
    expect(onStart).toHaveBeenCalledExactlyOnceWith(['Motion and forces']);
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('retains selection after busy/error rerenders and retries the same selected titles', async () => {
    const onStart = vi.fn();
    const onSkip = vi.fn();
    const props = { knowledgeMap, onStart, onSkip };
    await render(createElement(ScopePicker, props));
    await click(checkbox('Motion and forces'));
    await click(checkbox(customTitle));
    await click(button('clarify.startClass'));
    expect(onStart).toHaveBeenLastCalledWith([customTitle]);
    await render(createElement(ScopePicker, { ...props, submitting: true }));
    expect([...container.querySelectorAll('button')].every((element) => element.disabled)).toBe(
      true,
    );
    await render(createElement(ScopePicker, { ...props, error: 'Scope could not be saved' }));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Scope could not be saved');
    expect(checkbox(customTitle).getAttribute('aria-checked')).toBe('true');
    expect(checkbox('Motion and forces').getAttribute('aria-checked')).toBe('false');
    expect(button('preparationVisual.retryScope').disabled).toBe(false);
    expect(button('preparationVisual.retryScope').dataset.variant).toBe('default');
    await click(button('preparationVisual.retryScope'));
    expect(onStart).toHaveBeenNthCalledWith(2, [customTitle]);
    await click(button('clarify.selectRecommended'));
    expect(checkbox('Motion and forces').getAttribute('aria-checked')).toBe('true');
    expect(checkbox(customTitle).getAttribute('aria-checked')).toBe('false');
  });

  it('retains cached recommendations after submission failure without replacing the current choice', async () => {
    const onStart = vi.fn();
    const onSkip = vi.fn();
    const props = { knowledgeMap, onStart, onSkip };
    await render(createElement(ScopePicker, props));
    await click(checkbox('Motion and forces'));
    await click(checkbox(customTitle));
    await render(createElement(ScopePicker, { ...props, error: 'Save failed. '.repeat(80) }));
    expect(checkbox(customTitle).getAttribute('aria-checked')).toBe('true');
    expect(checkbox('Motion and forces').getAttribute('aria-checked')).toBe('false');
    await click(button('clarify.skipScope'));
    expect(onStart).toHaveBeenCalledExactlyOnceWith(['Motion and forces']);
    expect(onSkip).not.toHaveBeenCalled();
    expect(checkbox(customTitle).getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Save failed. '.repeat(80));
    expect(container.firstElementChild?.className).toContain('[overflow-wrap:anywhere]');
    expect(container.innerHTML).not.toMatch(/truncate|line-clamp|text-xs/);
    for (const action of container.querySelectorAll('button:not([role="checkbox"])')) {
      expect(action.className).toContain('min-h-11');
      expect(action.className).toContain('whitespace-normal');
      expect(action.className).toContain('max-w-full');
    }
    for (const option of container.querySelectorAll('label')) {
      expect(option.className).toContain('min-h-11');
    }
  });

  it('uses an explicit defaults action when no recommendation exists', async () => {
    const onStart = vi.fn();
    const onSkip = vi.fn();
    await render(
      createElement(ScopePicker, {
        knowledgeMap: {
          subject: 'Physics',
          topics: [{ id: 'custom', title: customTitle, recommended: false }],
        },
        onStart,
        onSkip,
      }),
    );
    expect(button('clarify.startClass').disabled).toBe(true);
    expect(container.textContent).not.toContain('clarify.selectRecommended');
    expect(container.textContent).not.toContain('clarify.scopeSubtitle');
    expect(
      [...container.querySelectorAll('button')].map((action) => action.textContent),
    ).not.toContain('clarify.skipScope');
    await click(button('clarify.skipScopeDefaults'));
    expect(onSkip).toHaveBeenCalledOnce();
    expect(onStart).not.toHaveBeenCalled();
  });
});

it('exposes segment progress and status and disables other retries during an active retry', async () => {
  const onRetry = vi.fn();
  const segments = [
    { outlineId: 'done', title: 'Completed topic', order: 0, status: 'completed' as const },
    { outlineId: 'failed', title: customTitle, order: 1, status: 'failed' as const },
    { outlineId: 'other', title: 'Other topic', order: 2, status: 'failed' as const },
  ];
  await render(createElement(SegmentList, { segments, onRetry, retryingId: null }));
  const progress = container.querySelector('progress');
  expect(progress?.value).toBe(1);
  expect(progress?.max).toBe(3);
  expect(container.querySelector('[data-status="failed"] h3')?.textContent).toContain(customTitle);
  expect(container.querySelector('[data-status="failed"] [role="status"]')?.textContent).toContain(
    'generation.segmentFailed',
  );
  const retry = container.querySelector<HTMLButtonElement>('[data-testid="retry-segment"]')!;
  await click(retry);
  expect(onRetry).toHaveBeenCalledExactlyOnceWith('failed');
  await render(createElement(SegmentList, { segments, onRetry, retryingId: 'failed' }));
  expect(
    [...container.querySelectorAll<HTMLButtonElement>('[data-testid="retry-segment"]')].every(
      (element) => element.disabled,
    ),
  ).toBe(true);
  expect(
    container.querySelector<HTMLButtonElement>('[data-testid="preview-segment-toggle"]')?.disabled,
  ).not.toBe(true);
});

it('counts only completed content and exposes all four real segment states', async () => {
  const segments = [
    { outlineId: 'waiting', title: '等待'.repeat(100), order: 0, status: 'waiting' as const },
    { outlineId: 'generating', title: 'Generating', order: 1, status: 'generating' as const },
    { outlineId: 'failed', title: 'Failed', order: 2, status: 'failed' as const },
    { outlineId: 'completed', title: 'Completed', order: 3, status: 'completed' as const },
  ];
  await render(createElement(SegmentList, { segments, onRetry: vi.fn(), retryingId: null }));
  expect(container.querySelector('progress')?.value).toBe(1);
  expect(container.querySelector('progress')?.max).toBe(4);
  expect(container.querySelectorAll('[data-testid="retry-segment"]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-testid="game-loader"]')).toHaveLength(1);
  expect(
    container.querySelector('[data-status="generating"] [data-testid="game-loader"]'),
  ).not.toBeNull();
  expect(container.querySelector('[data-status="waiting"] h3')?.textContent).toContain(
    segments[0].title,
  );
  expect(container.firstElementChild?.className).toContain('[overflow-wrap:anywhere]');
  expect(container.innerHTML).not.toMatch(/truncate|line-clamp|text-xs/);

  await render(
    createElement(SegmentList, {
      segments: segments.slice(0, 3),
      onRetry: vi.fn(),
      retryingId: null,
    }),
  );
  expect(container.querySelector('progress')?.value).toBe(0);
  expect(container.querySelector('progress')?.max).toBe(3);
});

it('lets a normally generating or completed segment open its classroom generation detail', async () => {
  const segments = [
    {
      outlineId: 'generating',
      title: 'Generating',
      order: 0,
      status: 'generating' as const,
      generatingPhase: 'content' as const,
      design: {
        teachingPoints: ['First point', 'Second point'],
        explanationPlan: 'Introduce then work an example.',
        anticipatedQuestions: [
          { question: 'What is the chain rule?', response: 'A derivative of a composition.' },
        ],
      },
    },
    {
      outlineId: 'quiz',
      title: 'Check',
      order: 1,
      status: 'completed' as const,
      scene: {
        id: 'quiz-scene',
        stageId: 'stage-1',
        type: 'quiz',
        title: 'Check',
        order: 1,
        content: {
          type: 'quiz',
          questions: [{ id: 'q1', type: 'single', question: 'What is the chain rule?' }],
        },
      } as Scene,
    },
  ];
  await render(createElement(SegmentList, { segments, onRetry: vi.fn(), retryingId: null }));
  expect(
    container.querySelector('[data-status="generating"] [data-testid="segment-detail"]'),
  ).not.toBeNull();
  expect(container.textContent).toContain('generation.segmentContentGenerating');
  expect(container.textContent).toContain('Second point');
  expect(container.textContent).toContain('What is the chain rule?');
  expect(container.textContent).toContain('A derivative of a composition.');
  expect(
    container.querySelector('[data-status="generating"] [data-testid="retry-segment"]'),
  ).toBeNull();
  assertReadOnly(container.querySelector('[data-testid="segment-detail"]')!);

  const completedToggle = container.querySelector<HTMLButtonElement>(
    '[data-status="completed"] [data-testid="preview-segment-toggle"]',
  )!;
  await click(completedToggle);
  expect(
    container.querySelector('[data-testid="segment-classroom-preview"]')?.textContent,
  ).toContain('What is the chain rule?');
  expect(container.querySelector('[data-status="completed"]')?.getAttribute('data-status')).toBe(
    'completed',
  );
  expect(
    container.querySelector('[data-status="completed"] [data-testid="retry-segment"]'),
  ).toBeNull();
});

it('opens completed slide / interactive / project materials without exposing retry', async () => {
  const onRetry = vi.fn();
  const segments = [
    {
      outlineId: 'slide',
      title: 'Intro',
      order: 0,
      status: 'completed' as const,
      scene: {
        id: 'slide-scene',
        stageId: 'stage-1',
        type: 'slide',
        title: 'Intro',
        order: 0,
        content: {
          type: 'slide',
          canvas: {
            id: 'canvas-intro',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme: {
              backgroundColor: '#fff',
              themeColors: ['#000'],
              fontColor: '#000',
              fontName: '',
            },
          },
        },
      } as Scene,
    },
    {
      outlineId: 'interactive',
      title: 'Try it',
      order: 1,
      status: 'completed' as const,
      scene: {
        id: 'interactive-scene',
        stageId: 'stage-1',
        type: 'interactive',
        title: 'Chain-rule sandbox',
        order: 1,
        content: { type: 'interactive', url: 'https://example.test' },
      } as Scene,
    },
    {
      outlineId: 'pbl',
      title: 'Project',
      order: 2,
      status: 'completed' as const,
      scene: {
        id: 'pbl-scene',
        stageId: 'stage-1',
        type: 'pbl',
        title: 'Build a derivative map',
        order: 2,
        content: { type: 'pbl' },
      } as Scene,
    },
    {
      outlineId: 'failed',
      title: 'Failed',
      order: 3,
      status: 'failed' as const,
    },
  ];
  await render(createElement(SegmentList, { segments, onRetry, retryingId: null }));
  const toggles = [
    ...container.querySelectorAll<HTMLButtonElement>('[data-testid="preview-segment-toggle"]'),
  ];
  await click(toggles[0]);
  await click(toggles[1]);
  await click(toggles[2]);
  expect(container.querySelector('[data-testid="slide-thumbnail"]')).not.toBeNull();
  expect(container.textContent).toContain('Chain-rule sandbox');
  expect(container.textContent).toContain('Build a derivative map');
  expect(container.querySelectorAll('[data-testid="retry-segment"]')).toHaveLength(1);
  expect(onRetry).not.toHaveBeenCalled();
  for (const preview of container.querySelectorAll('[data-testid="segment-classroom-preview"]')) {
    expect(preview.getAttribute('data-readonly')).toBe('true');
    assertReadOnly(preview);
  }
});

it('keeps the generation session when returning home so a generating course can be reopened', () => {
  const source = readFileSync('app/generation-preview/page.tsx', 'utf8');
  const goBack = source.slice(
    source.indexOf('const goBackToHome'),
    source.indexOf('const retryGeneration'),
  );
  expect(goBack).toContain('router.push');
  expect(goBack).not.toContain("removeItem('generationSession')");
});

describe('ConfirmationFailurePanel first-load recovery', () => {
  it('offers retry or skip-with-defaults and does not invent recommended topics', async () => {
    const onRetry = vi.fn();
    const onSkip = vi.fn();
    await render(createElement(ConfirmationFailurePanel, { kind: 'scope-error', onRetry, onSkip }));
    expect(container.querySelector('[data-testid="scope-first-load-error"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('clarify.scopeFailed');
    expect(container.textContent).toContain('preparationVisual.scopeSkipHelp');
    expect(container.querySelectorAll('button[role="checkbox"]')).toHaveLength(0);
    expect(container.textContent).not.toContain('clarify.recommended');
    expect(container.textContent).not.toContain('clarify.startClass');
    expect(container.textContent).not.toContain('clarify.selectRecommended');
    expect(
      [...container.querySelectorAll('button')].map((action) => action.textContent),
    ).not.toContain('clarify.skipScope');
    await click(button('clarify.retry'));
    expect(onRetry).toHaveBeenCalledOnce();
    await click(button('clarify.skipScopeDefaults'));
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it('keeps already-answered clarification skippable without a fake question card', async () => {
    await render(
      createElement(ConfirmationFailurePanel, {
        kind: 'clarify-error',
        onRetry: vi.fn(),
        onSkip: vi.fn(),
      }),
    );
    expect(container.querySelector('[data-testid="clarify-request-error"]')).not.toBeNull();
    expect(container.textContent).toContain('clarify.requestFailed');
    expect(container.textContent).toContain('preparationVisual.clarificationSkipHelp');
    expect(container.textContent).toContain('clarify.skip');
    expect(container.textContent).not.toContain('clarify.skipScopeDefaults');
    expect(container.querySelectorAll('button[role="checkbox"]')).toHaveLength(0);
  });
});

describe('LessonPlanPanel is read-only', () => {
  it('shows the plan title and nodes without editors', async () => {
    const plan = {
      title: '链式法则',
      nodes: [
        { id: 'n1', title: '引入' },
        { id: 'n2', title: '检查' },
      ],
    } as LessonPlan;
    await render(createElement(LessonPlanPanel, { plan }));
    expect(container.querySelector('[data-testid="lesson-plan-readonly"]')?.textContent).toContain(
      '链式法则',
    );
    expect(container.textContent).toContain('引入');
    expect(container.textContent).toContain('检查');
    expect(
      container
        .querySelector('[data-testid="lesson-plan-readonly"]')
        ?.getAttribute('data-readonly'),
    ).toBe('true');
    assertReadOnly();
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="lesson-plan-toggle"]',
    )!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('starts collapsed when the working segment list is already on screen', async () => {
    const plan = {
      title: '链式法则',
      nodes: [{ id: 'n1', title: '引入' }],
    } as LessonPlan;
    await render(createElement(LessonPlanPanel, { plan, compact: true }));
    expect(
      container.querySelector('[data-testid="lesson-plan-toggle"]')?.getAttribute('aria-expanded'),
    ).toBe('false');
  });
});

describe('SegmentClassroomPreview materials', () => {
  it('renders quiz stems, interactive titles, and project titles', async () => {
    await render(
      createElement(SegmentClassroomPreview, {
        scene: {
          id: 'quiz-scene',
          stageId: 'stage-1',
          type: 'quiz',
          title: 'Check',
          order: 1,
          content: {
            type: 'quiz',
            questions: [{ id: 'q1', type: 'single', question: 'What is the chain rule?' }],
          },
        } as Scene,
      }),
    );
    expect(container.textContent).toContain('What is the chain rule?');
    assertReadOnly();

    await render(
      createElement(SegmentClassroomPreview, {
        scene: {
          id: 'interactive-scene',
          stageId: 'stage-1',
          type: 'interactive',
          title: 'Chain-rule sandbox',
          order: 1,
          content: { type: 'interactive', url: 'https://example.test' },
        } as Scene,
      }),
    );
    expect(container.textContent).toContain('generation.interactivePreview');
    expect(container.textContent).toContain('Chain-rule sandbox');

    await render(
      createElement(SegmentClassroomPreview, {
        scene: {
          id: 'pbl-scene',
          stageId: 'stage-1',
          type: 'pbl',
          title: 'Build a derivative map',
          order: 2,
          content: { type: 'pbl' },
        } as Scene,
      }),
    );
    expect(container.textContent).toContain('generation.pblPreview');
    expect(container.textContent).toContain('Build a derivative map');
  });
});

// J2.0 / J2.0b / J2.3: page-only branches keep the existing state-machine
// commands. DOM interaction coverage above exercises the retained local values.
describe('GenerationPreview failure presentation boundary', () => {
  const source = readFileSync('app/generation-preview/page.tsx', 'utf8');

  it('wires first-load failures to the retry/skip panel and submit failures to the cached picker', () => {
    expect(source).toContain('ConfirmationFailurePanel');
    expect(source).toContain('kind={confirmStep.kind}');
    expect(source).toContain("settleConfirm({ type: 'retry' })");
    expect(source).toContain("settleConfirm({ type: 'skip' })");
    expect(source).toMatch(/setConfirmStep\(\{\s*kind: 'scope',\s*knowledgeMap,\s*error:/);
    expect(source).toContain('knowledgeMap={confirmStep.knowledgeMap}');
    expect(source).toContain('error={confirmStep.error}');
    expect(source).not.toContain('clarify.startClass');
    expect(source).not.toContain('toolbar.enterClassroom');
  });

  it('does not auto-enter the classroom, rewrite C on resume, or create W in preview', () => {
    expect(source).not.toContain('activeSteps.map(');
    expect(source).toContain("deckReady && confirmStep.kind === 'idle' ? (");
    expect(source).toContain('onClick={() => void enterClassroom()}');
    expect(source).toContain('if (!canEnterClassroom(segments, enteringClassroom)) return;');
    expect(source).toContain('classroomEnterTarget');
    expect(source).toContain('consumePendingClassroomEnterFailure');
    expect(source).toContain('data-testid="enter-classroom-error"');
    const persistIdx = source.indexOf('await persistGenerationCourseIntake');
    const confirmIdx = source.indexOf('await runPreLessonConfirmation');
    const outlineSseIdx = source.indexOf("log.debug('=== Generating outlines (SSE) ==='");
    expect(confirmIdx).toBeGreaterThan(0);
    expect(persistIdx).toBeGreaterThan(confirmIdx);
    expect(outlineSseIdx).toBeGreaterThan(persistIdx);
    expect(source).not.toMatch(/ClassroomWorkingMemory|createClassroomSession|finalizeSession/);
    expect(source).toContain('if (!target || !canRetrySegment(target.status)) return;');
  });
});

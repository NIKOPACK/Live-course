import { describe, expect, test } from 'vitest';
import {
  formatClarificationForPrompt,
  formatSelectedTopicsForPrompt,
} from '@/lib/livecourse/outline/types';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';

describe('formatClarificationForPrompt', () => {
  test('returns empty string for undefined / empty / fully-skipped answers', () => {
    expect(formatClarificationForPrompt(undefined)).toBe('');
    expect(formatClarificationForPrompt([])).toBe('');
    expect(
      formatClarificationForPrompt([
        { questionId: 'q1', question: '范围？', selectedOptionIds: [], selectedLabels: [] },
      ]),
    ).toBe('');
  });

  test('formats answered questions as a prompt block', () => {
    const text = formatClarificationForPrompt([
      {
        questionId: 'q1',
        question: '你想覆盖哪些部分？',
        selectedOptionIds: ['limits', 'diff'],
        selectedLabels: ['极限与连续', '一元微分'],
      },
    ]);

    expect(text).toContain("## Learner's Clarification Answers");
    expect(text).toContain('- 你想覆盖哪些部分？: 极限与连续、一元微分');
    expect(text).toContain('---');
  });
});

describe('formatSelectedTopicsForPrompt', () => {
  test('returns empty string for undefined / empty / blank-only topics', () => {
    expect(formatSelectedTopicsForPrompt(undefined)).toBe('');
    expect(formatSelectedTopicsForPrompt([])).toBe('');
    expect(formatSelectedTopicsForPrompt(['  ', ''])).toBe('');
  });

  test('formats selected topics as a scope block', () => {
    const text = formatSelectedTopicsForPrompt(['极限与连续', ' 一元微分 ']);

    expect(text).toContain('## Learner-Selected Scope');
    expect(text).toContain('- 极限与连续');
    expect(text).toContain('- 一元微分');
    expect(text).toContain('Cover exactly this scope');
  });
});

describe('requirements-to-outlines prompt injection', () => {
  const baseVars = {
    requirement: 'Teach limits to a beginner',
    pdfContent: 'None',
    availableImages: 'No images available',
    userProfile: '',
    researchContext: 'None',
    teacherContext: '',
    hasSourceImages: false,
    imageEnabled: false,
    videoEnabled: false,
    mediaEnabled: false,
  };

  test('renders no placeholders when clarification variables are omitted', () => {
    const prompt = buildPrompt(PROMPT_IDS.REQUIREMENTS_TO_OUTLINES, baseVars);
    expect(prompt).not.toBeNull();
    expect(prompt!.user).not.toContain('{{');
    expect(prompt!.user).not.toContain('Learner-Selected Scope');
  });

  test('injects clarification answers and selected topics when provided', () => {
    const prompt = buildPrompt(PROMPT_IDS.REQUIREMENTS_TO_OUTLINES, {
      ...baseVars,
      clarificationContext: formatClarificationForPrompt([
        {
          questionId: 'q1',
          question: 'Level?',
          selectedOptionIds: ['beginner'],
          selectedLabels: ['Beginner'],
        },
      ]),
      selectedTopicsText: formatSelectedTopicsForPrompt(['Limits', 'Continuity']),
    });

    expect(prompt).not.toBeNull();
    expect(prompt!.user).not.toContain('{{');
    expect(prompt!.user).toContain("## Learner's Clarification Answers");
    expect(prompt!.user).toContain('- Level?: Beginner');
    expect(prompt!.user).toContain('## Learner-Selected Scope');
    expect(prompt!.user).toContain('- Limits');
    // Injected after the research context.
    const user = prompt!.user;
    expect(user.indexOf('## Learner-Selected Scope')).toBeGreaterThan(
      user.indexOf('### Web Search Results'),
    );
  });
});

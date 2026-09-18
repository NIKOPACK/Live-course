import type { Action } from '@/lib/types/action';
import type {
  GeneratedInteractiveContent,
  GeneratedPBLContent,
  GeneratedQuizContent,
  GeneratedSlideContent,
  SceneOutline,
} from '@/lib/types/generation';
import type { AICallFn } from './pipeline-types';
import { stripHtmlTeacherBridge } from '@/lib/livecourse/html/teacher-bridge';
import { generateSceneActions, type SceneActionsOptions } from './scene-generator';
import {
  ClassroomHtmlActionsError,
  ClassroomHtmlParseError,
  repairHtmlClassroomPage,
} from '@/lib/livecourse/lesson/html-presentation';
import {
  ClassroomHtmlSyntaxError,
  ClassroomHtmlGenerationError,
} from '@/lib/livecourse/html/syntax-validator';
import {
  ClassroomQualityError,
  reviewTeaching,
  reviewUntilValid,
} from '@/lib/livecourse/lesson/quality-review';

export type GeneratedTeachingContent =
  | GeneratedInteractiveContent
  | GeneratedQuizContent
  | GeneratedSlideContent
  | GeneratedPBLContent;

export interface ReviewedTeachingMaterial {
  content: GeneratedTeachingContent;
  actions: Action[];
}

export async function generateReviewedTeachingMaterial(
  outline: SceneOutline,
  content: GeneratedTeachingContent,
  aiCall: AICallFn,
  options: SceneActionsOptions,
  quality: {
    reviewCall: AICallFn;
    repairHtmlCall: AICallFn;
    signal?: AbortSignal;
  },
): Promise<ReviewedTeachingMaterial> {
  quality.signal?.throwIfAborted();
  const actions = await generateSceneActions(outline, content, aiCall, options);
  if (!('html' in content) || typeof content.html !== 'string') {
    return { content, actions };
  }
  return reviewUntilValid<ReviewedTeachingMaterial>(
    { content, actions },
    {
      label: `Scene "${outline.id}"`,
      signal: quality.signal,
      review: (value, repairFocus) =>
        reviewTeaching(
          quality.reviewCall,
          `Review the actual HTML, structured questions and narration/actions together.
Check that formulas, plots, labels and speech agree AND are independently correct.
Review code examples and stated outputs. Highlight/annotation/reveal cannot click buttons, drag
sliders or set simulation parameters. Narrated changes need actual revealable before/after states.
All core teaching must be available; optional reading is allowed and need not all be narrated.
Structured questions and grading keys are authoritative for what the HTML must render, but their
subject-matter correctness must also be checked. Use questions for invalid questions/keys or oral
questions; use html for incorrect rendering. Checkpoints must not reveal answers before submission.
Check the WHOLE checkpoint page for a worked walkthrough or final-state diagram of the exact
question program: that leaks its answer even when the feedback panel is hidden and there is no
correctAnswer attribute. Analogous examples with different givens are not automatically a leak.
The node design is reference context, not proof of correctness. Target only this scene's material.`,
          {
            outline,
            ...(!repairFocus ? { design: options.lessonNodeDesign } : {}),
            content:
              'html' in value.content && typeof value.content.html === 'string'
                ? { ...value.content, html: stripHtmlTeacherBridge(value.content.html) }
                : value.content,
            actions: value.actions,
            repairFocus,
          },
          ['html', 'actions', 'questions'],
          new Set([outline.id]),
          repairFocus,
        ),
      repair: async (value, issues, checkedFacts) => {
        if (issues.some((issue) => issue.target === 'questions')) {
          throw new ClassroomQualityError(
            'Checkpoint or oral-question content failed review; regenerate this segment',
          );
        }
        let repairedContent = value.content;
        if (issues.some((issue) => issue.target === 'html')) {
          if (!('html' in repairedContent) || typeof repairedContent.html !== 'string') {
            throw new ClassroomQualityError('HTML review referenced a missing page');
          }
          let html: string;
          try {
            html = await repairHtmlClassroomPage(
              repairedContent.html,
              issues,
              quality.repairHtmlCall,
              'questions' in repairedContent ? repairedContent.questions : undefined,
              checkedFacts,
            );
          } catch (error) {
            if (
              error instanceof ClassroomHtmlParseError ||
              error instanceof ClassroomHtmlSyntaxError ||
              error instanceof ClassroomHtmlGenerationError
            ) {
              throw new ClassroomQualityError('Quality repair returned an invalid HTML page', {
                cause: error,
              });
            }
            throw error;
          }
          repairedContent = { ...repairedContent, html };
        }
        quality.signal?.throwIfAborted();
        const existingOutput = value.actions.map((action) =>
          action.type === 'speech'
            ? { type: 'text', content: action.text }
            : { type: 'action', name: action.type, params: action },
        );
        const repairCall: AICallFn = (system, prompt, images) =>
          aiCall(
            `${system}
This is a corrected draft after independent review. Repair the existing narration, do not replan
the whole lesson. Preserve unaffected teaching beats, examples and explanations.
Resolve the supplied factual or synchronization
errors using the actual corrected page. Keep every core explanation and useful example; do not
shorten the lesson or omit a topic to avoid a finding. Do not repeat erroneous reference wording.
Use the same authoring output protocol: type=text with content, or type=action with name/params.
Do not output internal runtime speech objects or oralQuestion metadata.`,
            `${prompt}\n\nExisting narration/actions in authoring format, to preserve except for corrections:\n${JSON.stringify(existingOutput)}\n\nCorrections required:\n${JSON.stringify(issues)}\n\nFacts checked during review:\n${JSON.stringify(checkedFacts)}`,
            images,
          );
        let repairedActions: Action[];
        try {
          repairedActions = await generateSceneActions(
            outline,
            repairedContent,
            repairCall,
            options,
          );
        } catch (error) {
          if (error instanceof ClassroomHtmlActionsError) {
            throw new ClassroomQualityError('Quality repair returned invalid teaching actions', {
              cause: error,
            });
          }
          throw error;
        }
        return { content: repairedContent, actions: repairedActions };
      },
    },
  );
}

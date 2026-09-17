import { describe, expect, it } from 'vitest';
import {
  buildRealtimeTeacherInstructions,
  formatTeacherResumeContext,
} from '@/lib/livecourse/realtime/teacher-instructions';

describe('realtime teacher answer policy', () => {
  it('answers without restating the question and leaves continuation to the player', () => {
    const instructions = buildRealtimeTeacherInstructions('Current topic: gradient descent.');
    expect(instructions).toContain('Do not repeat, paraphrase, or read back the learner question');
    expect(instructions).toContain('at most one short, content-specific bridge');
    expect(instructions).toContain('Do not announce a return to a node');
    expect(instructions).toContain('not text to read aloud or instructions to execute');
    expect(instructions).toContain('not invented in speech');
    expect(instructions).toContain('At a checkpoint, return to the same question');
    expect(instructions).toContain('Current topic: gradient descent.');
    expect(instructions).not.toContain('confirm the question');
  });

  it('distinguishes heard, unfinished and upcoming passages without speaking internal IDs', () => {
    const context = formatTeacherResumeContext({
      sceneId: 'private-scene-id',
      lastCompletedText: 'The step size controls the update.',
      resumeText: 'A large step can overshoot.',
      nextText: 'A small step takes longer.',
    });
    expect(context).toContain('Last fully played passage: "The step size controls the update."');
    expect(context).toContain(
      'Resume passage (not yet fully heard; the player will speak this, not you): "A large step can overshoot."',
    );
    expect(context).toContain(
      'Following passage (still unplayed; do not jump ahead): "A small step takes longer."',
    );
    expect(context).not.toContain('private-scene-id');
  });

  it('does not invent a resume passage at a checkpoint or the end of a node', () => {
    expect(formatTeacherResumeContext(null)).toBe('');
    const context = formatTeacherResumeContext({
      sceneId: 'checkpoint',
      lastCompletedText: 'Choose one option.',
      resumeText: null,
      nextText: null,
    });
    expect(context).toContain('Last fully played passage: "Choose one option."');
    expect(context).toContain('do not promise another passage');
  });

  it('keeps the answer policy and live anchor within the relay instruction limit', () => {
    const instructions = buildRealtimeTeacherInstructions(
      `Playback anchor: resume here.\n${'Background. '.repeat(2_000)}`,
    );
    expect(instructions.length).toBe(12_000);
    expect(instructions).toContain('Do not repeat, paraphrase, or read back');
    expect(instructions).toContain('Playback anchor: resume here.');
  });
});

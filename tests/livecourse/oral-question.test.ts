import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OralQuestionSession,
  shouldBindOralQuestionPort,
  type OralQuestionState,
} from '@/lib/livecourse/realtime/client/oral-question';

const question = {
  question: 'Why does the slope change?',
  guidance: 'Reason about the changing rate, not the height.',
};
const labels = { hintText: 'Give me a hint.', resumeText: 'Let us continue.' };
const active: OralQuestionSession[] = [];
async function flush() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}
function setup(manualMicrophoneResponse = false) {
  const states: OralQuestionState[] = [];
  const port = {
    speak: vi.fn(async () => undefined),
    respond: vi.fn(async () => undefined),
    updateInstructions: vi.fn(async (): Promise<void> => undefined),
    setListening: vi.fn(),
    cancel: vi.fn(async () => undefined),
    manualMicrophoneResponse,
    onState: (state: OralQuestionState) => states.push(state),
  };
  const controller = new AbortController();
  const oral = new OralQuestionSession(question, port, { ...labels, signal: controller.signal });
  active.push(oral);
  const completion = oral.run();
  void completion.catch(() => undefined);
  return { oral, port, states, completion, controller };
}
afterEach(() => {
  for (const oral of active.splice(0)) oral.cancel();
  vi.useRealTimers();
});

describe('bounded oral classroom dialogue', () => {
  it('retries only the next-context refresh after feedback was already spoken', async () => {
    const { oral, port } = setup();
    await flush();
    port.respond.mockImplementationOnce(async () => {
      oral.teacherTranscript('Why does that affect the next point?');
    });
    port.updateInstructions
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Context update failed'));
    await expect(oral.answer('Because of the local rate.')).rejects.toThrow(
      'Context update failed',
    );
    expect(oral.state.answeredRounds).toBe(0);
    await oral.retry();
    expect(oral.state).toMatchObject({ phase: 'waiting', answeredRounds: 1 });
    expect(port.respond).toHaveBeenCalledOnce();
    await oral.answer('The next point has a different rate.');
    expect(port.updateInstructions).toHaveBeenCalledWith(
      expect.stringContaining('Why does that affect the next point?'),
    );
  });

  it('cancels a timed-out native reply without counting the incomplete round', async () => {
    vi.useFakeTimers();
    const { oral, port } = setup();
    await flush();
    oral.nativeStarted();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(oral.state).toMatchObject({
      phase: 'failed',
      answer: '',
      answeredRounds: 0,
    });
    expect(port.cancel).toHaveBeenCalledOnce();
    oral.nativeCompleted();
    expect(oral.state.answeredRounds).toBe(0);
    await oral.retry();
    expect(oral.state.phase).toBe('waiting');
    expect(oral.state.answeredRounds).toBe(0);
  });

  it('does not time out a Volc answer while the teacher is still speaking', async () => {
    vi.useFakeTimers();
    const { oral, port } = setup();
    await flush();
    oral.nativeStarted();
    oral.nativeTranscript('My reasoning.');
    await vi.advanceTimersByTimeAsync(90_000);
    expect(oral.state).toMatchObject({
      phase: 'responding',
      answer: 'My reasoning.',
      answeredRounds: 0,
    });
    expect(port.cancel).not.toHaveBeenCalled();
    oral.teacherTranscript('Here is why that rate matters.');
    oral.nativeCompleted();
    await flush();
    expect(oral.state).toMatchObject({ phase: 'waiting', answeredRounds: 1 });
  });

  it('does not restore provider context while a cancelled context write is still pending', async () => {
    const { oral, port, completion, controller } = setup();
    await flush();
    let finish!: () => void;
    port.updateInstructions.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const hint = oral.hint();
    void hint.catch(() => undefined);
    const settled = vi.fn();
    void completion.catch(settled);
    controller.abort();
    await flush();
    expect(settled).not.toHaveBeenCalled();
    finish();
    await expect(completion).rejects.toMatchObject({ name: 'AbortError' });
    await expect(hint).rejects.toMatchObject({ name: 'AbortError' });
    expect(port.respond).not.toHaveBeenCalled();
  });
  it('asks, waits indefinitely without inventing an answer, and supports explicit continuation', async () => {
    vi.useFakeTimers();
    const { oral, port, completion } = setup();
    await flush();
    expect(port.speak).toHaveBeenCalledWith(question.question, expect.any(AbortSignal));
    expect(oral.state.phase).toBe('waiting');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(port.respond).not.toHaveBeenCalled();
    expect(oral.state.phase).toBe('waiting');
    await oral.end();
    await completion;
    expect(port.speak).toHaveBeenLastCalledWith(labels.resumeText, expect.any(AbortSignal));
  });

  it('uses final voice input and real audio completion, then ends after two follow-ups', async () => {
    const { oral, port, completion } = setup();
    await flush();
    for (let round = 0; round < 3; round++) {
      expect(oral.nativeStarted()).toBe(true);
      expect(oral.nativeStarted()).toBe(false);
      oral.nativeTranscript(`My reasoning ${round}`);
      oral.nativeTranscript('duplicate');
      expect(oral.state.answeredRounds).toBe(round);
      oral.teacherTranscript(`Feedback and follow-up ${round}`);
      oral.nativeCompleted();
      await flush();
      if (round < 2) {
        expect(oral.state.phase).toBe('waiting');
        expect(oral.state.answeredRounds).toBe(round + 1);
        expect(oral.instructions).toContain(`Feedback and follow-up ${round}`);
      }
    }
    await completion;
    expect(port.respond).not.toHaveBeenCalled();
    expect(port.updateInstructions).toHaveBeenLastCalledWith(
      expect.stringContaining('final answer round'),
    );
    expect(port.setListening).toHaveBeenLastCalledWith(false);
  });

  it('routes OpenAI microphone answers to a single controlled response', async () => {
    const { oral, port } = setup(true);
    await flush();
    oral.nativeStarted();
    oral.nativeTranscript('It is the local rate.');
    oral.nativeTranscript('duplicate');
    await flush();
    expect(port.respond).toHaveBeenCalledWith(
      'It is the local rate.',
      expect.any(AbortSignal),
      true,
    );
    expect(port.respond).toHaveBeenCalledOnce();
    expect(oral.state.answeredRounds).toBe(1);
    expect(oral.state.phase).toBe('waiting');
  });

  it('preserves a failed answer for retry and does not count hints as answers', async () => {
    const { oral, port } = setup();
    await flush();
    await oral.hint();
    expect(oral.state.answeredRounds).toBe(0);
    expect(port.respond).toHaveBeenCalledWith(labels.hintText, expect.any(AbortSignal), false);
    port.respond.mockRejectedValueOnce(new Error('Response failed'));
    await expect(oral.answer('My explanation')).rejects.toThrow('Response failed');
    expect(oral.state).toMatchObject({
      phase: 'failed',
      answer: 'My explanation',
      answeredRounds: 0,
    });
    await oral.retry();
    expect(oral.state).toMatchObject({ phase: 'waiting', answeredRounds: 1 });
    expect(port.respond).toHaveBeenLastCalledWith('My explanation', expect.any(AbortSignal), false);
  });

  it('keeps the question open after recognition failure and cancels on pause', async () => {
    const { oral, port, completion, controller } = setup();
    await flush();
    oral.nativeStarted();
    oral.nativeFailed(new Error('Could not hear you'));
    await flush();
    expect(oral.state).toMatchObject({
      phase: 'failed',
      answeredRounds: 0,
      error: 'Could not hear you',
    });
    expect(port.respond).not.toHaveBeenCalled();
    expect(port.cancel).toHaveBeenCalledOnce();
    await oral.retry();
    expect(oral.state.phase).toBe('waiting');
    controller.abort();
    await expect(completion).rejects.toMatchObject({ name: 'AbortError' });
    expect(oral.nativeStarted()).toBe(false);
    expect(port.setListening).toHaveBeenLastCalledWith(false);
  });

  it('does not bind the oral-question port during replay or in-class relisten', () => {
    expect(shouldBindOralQuestionPort({ relistening: false, classroomState: 'teaching' })).toBe(
      true,
    );
    expect(shouldBindOralQuestionPort({ relistening: true, classroomState: 'teaching' })).toBe(
      false,
    );
    expect(shouldBindOralQuestionPort({ relistening: false, classroomState: 'replaying' })).toBe(
      false,
    );
  });
});

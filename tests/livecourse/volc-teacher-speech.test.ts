import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionMocks = vi.hoisted(() => ({
  connect: vi.fn(async (_instructions: string) => undefined),
  preparePlayback: vi.fn(async () => undefined),
  speakText: vi.fn(
    async (_text: string, _options?: { requireAudio?: boolean }): Promise<void> => undefined,
  ),
  askQuestion: vi.fn(
    async (_text: string, _options?: { requireAudio?: boolean }): Promise<void> => undefined,
  ),
  cancelNarration: vi.fn(async () => undefined),
  mute: vi.fn(),
  close: vi.fn(async (): Promise<void> => undefined),
  updateInstructions: vi.fn(async (_instructions: string): Promise<void> => undefined),
  setInputEnabled: vi.fn(),
  onEvent: undefined as ((event: unknown) => void) | undefined,
  captureMicrophone: undefined as boolean | undefined,
}));

vi.mock('@/lib/livecourse/realtime/volc/client', () => ({
  VolcRealtimeBrowserSession: class FakeVolcRealtimeBrowserSession {
    constructor(options: { onEvent?: (event: unknown) => void; captureMicrophone?: boolean }) {
      sessionMocks.onEvent = options.onEvent;
      sessionMocks.captureMicrophone = options.captureMicrophone;
    }
    connect = sessionMocks.connect;
    preparePlayback = sessionMocks.preparePlayback;
    speakText = sessionMocks.speakText;
    askQuestion = sessionMocks.askQuestion;
    cancelNarration = sessionMocks.cancelNarration;
    mute = sessionMocks.mute;
    close = sessionMocks.close;
    updateInstructions = sessionMocks.updateInstructions;
    setInputEnabled = sessionMocks.setInputEnabled;
  },
}));

import { VolcTeacherSpeechSession } from '@/lib/livecourse/realtime/client/volc-teacher-speech';
import {
  buildRealtimeTeacherInstructions,
  formatTeacherResumeContext,
} from '@/lib/livecourse/realtime/teacher-instructions';

const instantRetry = {
  sleep: async () => undefined,
  random: () => 0,
  baseDelayMs: 0,
  maxDelayMs: 0,
};

describe('VolcTeacherSpeechSession', () => {
  beforeEach(() => {
    sessionMocks.connect.mockClear();
    sessionMocks.preparePlayback.mockClear();
    sessionMocks.speakText.mockReset().mockResolvedValue(undefined);
    sessionMocks.askQuestion.mockReset().mockResolvedValue(undefined);
    sessionMocks.cancelNarration.mockReset().mockResolvedValue(undefined);
    sessionMocks.mute.mockClear();
    sessionMocks.close.mockReset().mockResolvedValue(undefined);
    sessionMocks.updateInstructions.mockReset().mockResolvedValue(undefined);
    sessionMocks.setInputEnabled.mockClear();
    sessionMocks.onEvent = undefined;
    sessionMocks.captureMicrophone = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each(['connect', 'ask', 'speak'] as const)(
    'shares a pending transport with a concurrent %s caller',
    async (operation) => {
      let release!: () => void;
      sessionMocks.connect.mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            release = () => resolve(undefined);
          }),
      );
      const session = new VolcTeacherSpeechSession({ getInstructions: () => 'Current checkpoint' });
      const connecting = session.connect();
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      const concurrent =
        operation === 'connect' ? session.connect() : session[operation]('Question or narration');
      const completed = Promise.allSettled([connecting, concurrent]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      release();
      const results = await completed;
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(sessionMocks.connect).toHaveBeenCalledOnce();
      expect(session.connected).toBe(true);
      await session.close();
    },
  );

  it('refreshes the non-echoing answer policy and playback anchor before native interruptions', async () => {
    let resumeText = 'First unplayed passage.';
    const getInstructions = () =>
      formatTeacherResumeContext({
        sceneId: 'scene',
        lastCompletedText: 'Already heard.',
        resumeText,
        nextText: 'Following passage.',
      });
    const interruptNode = vi.fn(async () => undefined);
    const resumeNode = vi.fn(async () => undefined);
    const session = new VolcTeacherSpeechSession({
      getInstructions,
      getLocation: () => ({ nodeId: 'node:scene', sceneId: 'scene' }),
      interruptNode,
      resumeNode,
    });
    await session.connect();
    expect(sessionMocks.connect).toHaveBeenCalledWith(
      buildRealtimeTeacherInstructions(getInstructions()),
    );
    resumeText = 'Second unplayed passage.';
    await session.speak(resumeText);
    expect(sessionMocks.updateInstructions).toHaveBeenLastCalledWith(
      buildRealtimeTeacherInstructions(getInstructions()),
    );
    expect(sessionMocks.updateInstructions.mock.invocationCallOrder.at(-1)).toBeLessThan(
      sessionMocks.speakText.mock.invocationCallOrder.at(-1)!,
    );
    sessionMocks.onEvent?.({ type: 'learner_turn_started' });
    sessionMocks.onEvent?.({ type: 'learner_answer', text: 'Why?' });
    await vi.waitFor(() => expect(interruptNode).toHaveBeenCalledOnce());
    expect(sessionMocks.askQuestion).not.toHaveBeenCalled();
    expect(resumeNode).not.toHaveBeenCalled();
    sessionMocks.onEvent?.({ type: 'audio_completed', hasAudio: true });
    await vi.waitFor(() => expect(resumeNode).toHaveBeenCalledOnce());
    await session.close();
  });

  it('releases a held interruption before disconnecting, without completing an answer', async () => {
    const interruptNode = vi.fn(async () => undefined);
    const resumeNode = vi.fn(async () => undefined);
    const events: Array<{ type: string }> = [];
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Checkpoint.',
      getLocation: () => ({ nodeId: 'node:check', sceneId: 'check' }),
      interruptNode,
      resumeNode,
      onEvent: (event) => events.push(event),
    });
    await session.connect();
    sessionMocks.onEvent?.({ type: 'learner_turn_started' });
    await vi.waitFor(() => expect(interruptNode).toHaveBeenCalledOnce());
    await session.close();
    expect(resumeNode).toHaveBeenCalledExactlyOnceWith('node:check');
    expect(resumeNode.mock.invocationCallOrder[0]).toBeLessThan(
      sessionMocks.close.mock.invocationCallOrder[0],
    );
    expect(events.filter((event) => event.type === 'node_resumed')).toHaveLength(1);
    expect(sessionMocks.askQuestion).not.toHaveBeenCalled();
    expect(session.connected).toBe(false);
  });

  it('waits for the pending interruption commit and coalesces concurrent closes', async () => {
    let commit!: () => void;
    const interruptNode = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          commit = resolve;
        }),
    );
    const resumeNode = vi.fn(async () => undefined);
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Checkpoint.',
      getLocation: () => ({ nodeId: 'node:check', sceneId: 'check' }),
      interruptNode,
      resumeNode,
    });
    await session.connect();
    sessionMocks.onEvent?.({ type: 'learner_turn_started' });
    await vi.waitFor(() => expect(commit).toBeTypeOf('function'));
    const first = session.close();
    const second = session.close();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(resumeNode).not.toHaveBeenCalled();
    expect(sessionMocks.close).not.toHaveBeenCalled();
    await expect(session.connect()).rejects.toThrow(/clos/i);
    await expect(session.ask('Another question')).rejects.toThrow(/clos/i);
    await expect(session.speak('Late narration')).rejects.toThrow(/clos/i);
    sessionMocks.onEvent?.({ type: 'learner_turn_started' });
    sessionMocks.onEvent?.({ type: 'audio_completed', hasAudio: true });
    commit();
    await Promise.all([first, second]);
    expect(resumeNode).toHaveBeenCalledOnce();
    expect(interruptNode).toHaveBeenCalledOnce();
    expect(sessionMocks.close).toHaveBeenCalledOnce();
  });

  it('retains the connection and held node when close-time recovery fails', async () => {
    const interruptNode = vi.fn(async () => undefined);
    const resumeNode = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error('Resume persistence failed'));
    const events: Array<{ type: string }> = [];
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Checkpoint.',
      getLocation: () => ({ nodeId: 'node:check', sceneId: 'check' }),
      interruptNode,
      resumeNode,
      onEvent: (event) => events.push(event),
    });
    await session.connect();
    sessionMocks.onEvent?.({ type: 'learner_turn_started' });
    await vi.waitFor(() => expect(interruptNode).toHaveBeenCalledOnce());
    await expect(session.close()).rejects.toThrow('Resume persistence failed');
    expect(session.connected).toBe(true);
    expect(sessionMocks.close).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'node_resumed')).toHaveLength(0);
    await session.close();
    expect(resumeNode).toHaveBeenCalledTimes(2);
    expect(interruptNode).toHaveBeenCalledOnce();
    expect(sessionMocks.close).toHaveBeenCalledOnce();
  });

  it('does not re-freeze or repeat a resume that was pending when close began', async () => {
    let release!: () => void;
    const events: Array<{ type: string }> = [];
    const interruptNode = vi.fn(async () => undefined);
    const resumeNode = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Checkpoint.',
      getLocation: () => ({ nodeId: 'node:check', sceneId: 'check' }),
      interruptNode,
      resumeNode,
      onEvent: (event) => events.push(event),
    });
    await session.connect();
    sessionMocks.onEvent?.({ type: 'learner_turn_started' });
    await vi.waitFor(() => expect(interruptNode).toHaveBeenCalledOnce());
    sessionMocks.onEvent?.({ type: 'audio_completed', hasAudio: true });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const closing = session.close();
    release();
    await closing;
    expect(interruptNode).toHaveBeenCalledOnce();
    expect(resumeNode).toHaveBeenCalledOnce();
    expect(sessionMocks.close).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === 'node_resumed')).toHaveLength(1);
  });

  it.each([false, true])(
    'closes an idle session without recovery writes (readOnly=%s)',
    async (readOnly) => {
      const interruptNode = vi.fn(async () => undefined);
      const resumeNode = vi.fn(async () => undefined);
      const session = new VolcTeacherSpeechSession({
        getInstructions: () => 'Checkpoint.',
        getLocation: () => ({ nodeId: 'node:check', sceneId: 'check' }),
        readOnly,
        interruptNode,
        resumeNode,
      });
      await session.connect();
      await session.close();
      expect(interruptNode).not.toHaveBeenCalled();
      expect(resumeNode).not.toHaveBeenCalled();
      await session.connect();
      expect(session.connected).toBe(true);
      await session.close();
    },
  );

  it('retains the transport for a retry when transport close rejects', async () => {
    const session = new VolcTeacherSpeechSession({ getInstructions: () => 'Checkpoint.' });
    await session.connect();
    sessionMocks.close.mockRejectedValueOnce(new Error('Transport close failed'));
    await expect(session.close()).rejects.toThrow('Transport close failed');
    expect(session.connected).toBe(true);
    await session.close();
    expect(sessionMocks.close).toHaveBeenCalledTimes(2);
    expect(session.connected).toBe(false);
  });

  it('does not attach a reconnect that was waiting on the previous transport when closed', async () => {
    const session = new VolcTeacherSpeechSession({ getInstructions: () => 'Checkpoint.' });
    await session.connect();
    sessionMocks.onEvent?.({ type: 'status', status: 'error' });
    let release!: () => void;
    sessionMocks.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const reconnect = session.connect();
    const rejected = expect(reconnect).rejects.toThrow(/clos/i);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await session.close();
    release();
    await rejected;
    expect(session.connected).toBe(false);
    expect(sessionMocks.connect).toHaveBeenCalledOnce();
  });

  it.each(['connect', 'speak'])('cancels a delayed %s retry when closed', async (operation) => {
    let release!: () => void;
    sessionMocks.connect.mockRejectedValueOnce(new Error('HTTP 503 Service Unavailable'));
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Checkpoint.',
      speechRetry: {
        ...instantRetry,
        sleep: () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      },
    });
    const pending = operation === 'connect' ? session.connect() : session.speak('A sentence.');
    const rejected = expect(pending).rejects.toThrow(/clos/i);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await session.close();
    release();
    await rejected;
    expect(session.connected).toBe(false);
    expect(sessionMocks.connect).toHaveBeenCalledOnce();
    expect(sessionMocks.speakText).not.toHaveBeenCalled();
  });

  it('reconnects and preserves mute when an input timeout interrupts authored narration', async () => {
    sessionMocks.speakText.mockRejectedValueOnce(
      new Error('sami error: codes=52000033, desc=AudioServerNoAudioInputTooLongError'),
    );
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Current node context.',
      speechRetry: instantRetry,
    });
    await session.connect();
    session.mute(true);
    await session.speak('Repeat only this unfinished sentence.');
    expect(sessionMocks.connect).toHaveBeenCalledTimes(2);
    expect(sessionMocks.speakText).toHaveBeenCalledTimes(2);
    expect(sessionMocks.speakText).toHaveBeenLastCalledWith(
      'Repeat only this unfinished sentence.',
      { requireAudio: true },
    );
    expect(sessionMocks.mute).toHaveBeenCalledTimes(2);
    expect(sessionMocks.mute).toHaveBeenLastCalledWith(true);
    await session.close();
  });

  it('reconnects a failed typed question without repeating the interruption transaction', async () => {
    sessionMocks.askQuestion.mockRejectedValueOnce(
      new Error('AudioServerNoAudioInputTooLongError'),
    );
    const interruptNode = vi.fn(async () => undefined);
    const resumeNode = vi.fn(async () => undefined);
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Current node context.',
      getLocation: () => ({ sceneId: 'current-scene', nodeId: 'current-node' }),
      interruptNode,
      resumeNode,
      speechRetry: instantRetry,
    });
    await session.connect();
    await session.ask('Why?');
    expect(sessionMocks.connect).toHaveBeenCalledTimes(2);
    expect(sessionMocks.askQuestion).toHaveBeenCalledTimes(2);
    expect(interruptNode).toHaveBeenCalledExactlyOnceWith('current-node');
    expect(resumeNode).toHaveBeenCalledExactlyOnceWith('current-node');
    await session.close();
  });

  it('waits for real oral feedback, follows up twice and never uses ordinary interruption/resume', async () => {
    const interruptNode = vi.fn();
    const resumeNode = vi.fn();
    const states: Array<{ phase: string; answeredRounds: number } | null> = [];
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Normal lesson instructions.',
      interruptNode,
      resumeNode,
      onEvent: (event) => {
        if (event.type === 'oral_question') states.push(event.state);
      },
    });
    await session.connect();
    const completion = session.question(
      { question: 'Why does the rate change?', guidance: 'Reason about local changes.' },
      {
        hintText: 'Give me a hint.',
        resumeText: 'Let us continue.',
      },
    );
    await vi.waitFor(() => expect(states.at(-1)?.phase).toBe('waiting'));
    expect(sessionMocks.speakText).toHaveBeenLastCalledWith('Why does the rate change?', {
      requireAudio: true,
    });
    for (let round = 0; round < 3; round++) {
      sessionMocks.onEvent?.({ type: 'learner_turn_started' });
      sessionMocks.onEvent?.({ type: 'learner_answer', text: `Answer ${round}` });
      sessionMocks.onEvent?.({ type: 'speaking', speaking: true });
      sessionMocks.onEvent?.({
        type: 'transcript',
        speaker: 'teacher',
        text: `Follow-up ${round}`,
      });
      sessionMocks.onEvent?.({ type: 'speaking', speaking: false });
      expect(states.at(-1)?.answeredRounds).toBe(round);
      sessionMocks.onEvent?.({ type: 'audio_completed', hasAudio: true });
      if (round < 2) await vi.waitFor(() => expect(states.at(-1)?.answeredRounds).toBe(round + 1));
    }
    await completion;
    expect(states.at(-1)).toBeNull();
    expect(interruptNode).not.toHaveBeenCalled();
    expect(resumeNode).not.toHaveBeenCalled();
    expect(sessionMocks.askQuestion).not.toHaveBeenCalled();
    expect(sessionMocks.updateInstructions).toHaveBeenLastCalledWith(
      buildRealtimeTeacherInstructions('Normal lesson instructions.'),
    );
    expect(sessionMocks.setInputEnabled).toHaveBeenLastCalledWith(true);
    await session.close();
  });

  it('supports typed oral answers and hints while preserving the learner mute preference', async () => {
    const states: Array<{ phase: string; answeredRounds: number } | null> = [];
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Normal lesson instructions.',
      onEvent: (event) => {
        if (event.type === 'oral_question') states.push(event.state);
      },
    });
    await session.connect();
    session.mute(true);
    const completion = session.question(
      { question: 'Why?', guidance: 'Reason about the rate.' },
      {
        hintText: 'Give a hint.',
        resumeText: 'Continue.',
      },
    );
    await vi.waitFor(() => expect(states.at(-1)?.phase).toBe('waiting'));
    await session.hintOralQuestion();
    expect(states.at(-1)?.answeredRounds).toBe(0);
    expect(sessionMocks.askQuestion).toHaveBeenLastCalledWith('Give a hint.', {
      requireAudio: true,
    });
    await session.ask('It is a local change.');
    expect(states.at(-1)?.answeredRounds).toBe(1);
    expect(sessionMocks.askQuestion).toHaveBeenLastCalledWith('It is a local change.', {
      requireAudio: true,
    });
    await session.endOralQuestion();
    await completion;
    expect(sessionMocks.mute).toHaveBeenCalledExactlyOnceWith(true);
    await session.close();
  });

  it('finishes cancelled dialogue cleanup before restarting authored narration', async () => {
    const states: Array<{ phase: string } | null> = [];
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Normal lesson instructions.',
      onEvent: (event) => {
        if (event.type === 'oral_question') states.push(event.state);
      },
    });
    await session.connect();
    const controller = new AbortController();
    const completion = session.question(
      { question: 'Why?', guidance: 'Explain your reasoning.' },
      {
        hintText: 'Hint.',
        resumeText: 'Continue.',
        signal: controller.signal,
      },
    );
    void completion.catch(() => undefined);
    await vi.waitFor(() => expect(states.at(-1)?.phase).toBe('waiting'));
    let restored!: () => void;
    sessionMocks.updateInstructions.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          restored = resolve;
        }),
    );
    controller.abort();
    const restarted = session.speak('Restarted lecture.');
    await vi.waitFor(() => expect(restored).toBeTypeOf('function'));
    expect(sessionMocks.speakText).not.toHaveBeenCalledWith(
      'Restarted lecture.',
      expect.anything(),
    );
    restored();
    await expect(completion).rejects.toMatchObject({ name: 'AbortError' });
    await restarted;
    expect(sessionMocks.speakText).toHaveBeenLastCalledWith('Restarted lecture.', {
      requireAudio: true,
    });
    await session.close();
  });

  it('does not start a Volc oral response after the playback attempt was cancelled', async () => {
    const states: Array<{ phase: string } | null> = [];
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Normal lesson instructions.',
      onEvent: (event) => {
        if (event.type === 'oral_question') states.push(event.state);
      },
    });
    await session.connect();
    const controller = new AbortController();
    const completion = session.question(
      { question: 'Why?', guidance: 'Explain your reasoning.' },
      {
        hintText: 'Hint.',
        resumeText: 'Continue.',
        signal: controller.signal,
      },
    );
    void completion.catch(() => undefined);
    await vi.waitFor(() => expect(states.at(-1)?.phase).toBe('waiting'));
    let release!: () => void;
    sessionMocks.updateInstructions.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const answering = session.ask('It is a local change.');
    void answering.catch(() => undefined);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    controller.abort();
    release();
    await expect(completion).rejects.toMatchObject({ name: 'AbortError' });
    expect(sessionMocks.askQuestion).not.toHaveBeenCalled();
    await session.close();
  });

  it('connects through the Volc relay and speaks narration', async () => {
    const events: string[] = [];
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Teach photosynthesis.',
      onEvent: (event) => events.push(event.type),
    });

    await session.connect();
    expect(sessionMocks.preparePlayback).toHaveBeenCalledOnce();
    expect(sessionMocks.connect).toHaveBeenCalledWith(
      buildRealtimeTeacherInstructions('Teach photosynthesis.'),
    );
    expect(session.connected).toBe(true);

    await session.speak('叶绿体吸收光能。');
    expect(sessionMocks.speakText).toHaveBeenCalledWith('叶绿体吸收光能。', { requireAudio: true });

    await session.ask('什么是光反应？');
    expect(sessionMocks.askQuestion).toHaveBeenCalledWith('什么是光反应？', { requireAudio: true });
    expect(sessionMocks.speakText).not.toHaveBeenCalledWith(
      expect.stringContaining('请先确认收到'),
    );

    await session.close();
    expect(session.connected).toBe(false);
    expect(sessionMocks.close).toHaveBeenCalledOnce();
    expect(events[0]).toBe('status');
    expect(events).toContain('transcript');
  });

  it('does not require a microphone to start teacher narration', async () => {
    vi.stubGlobal('window', { isSecureContext: false });
    vi.stubGlobal('navigator', {});
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Teach Fourier analysis.',
    });
    await session.connect();
    expect(sessionMocks.captureMicrophone).toBe(false);
    expect(sessionMocks.connect).toHaveBeenCalledOnce();
    await session.speak('先把波形拆成正弦波。');
    expect(sessionMocks.speakText).toHaveBeenCalledWith('先把波形拆成正弦波。', {
      requireAudio: true,
    });
  });

  it('opens the microphone in a secure context so the learner can barge in', async () => {
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Teach Fourier analysis.',
    });
    await session.connect();
    expect(sessionMocks.captureMicrophone).toBe(true);
  });

  it('freezes playback, answers the typed question, then resumes the node', async () => {
    const interruptNode = vi.fn(async () => undefined);
    const resumeNode = vi.fn(async () => undefined);
    const events: string[] = [];
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Teach Fourier analysis.',
      getLocation: () => ({ nodeId: 'node:intro', sceneId: 'scene-why' }),
      canInterrupt: () => true,
      interruptNode,
      resumeNode,
      onEvent: (event) => events.push(event.type),
    });
    await session.connect();
    await session.ask('傅里叶变换和拉普拉斯变换有什么区别？');

    expect(interruptNode).toHaveBeenCalledWith('node:intro');
    expect(sessionMocks.askQuestion).toHaveBeenCalledWith('傅里叶变换和拉普拉斯变换有什么区别？', {
      requireAudio: true,
    });
    expect(resumeNode).toHaveBeenCalledWith('node:intro');
    expect(events).toContain('interrupted');
    expect(events).toContain('node_resumed');
    expect(sessionMocks.close).not.toHaveBeenCalled();
  });

  it('retries a voice-model error then speaks the same script', async () => {
    sessionMocks.speakText
      .mockRejectedValueOnce(new Error('Volc realtime failed'))
      .mockResolvedValueOnce(undefined);
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Teach Newton.',
      speechRetry: instantRetry,
    });
    await session.connect();
    await session.speak('力是改变运动的原因。');
    expect(sessionMocks.speakText).toHaveBeenCalledTimes(2);
    expect(sessionMocks.speakText).toHaveBeenNthCalledWith(2, '力是改变运动的原因。', {
      requireAudio: true,
    });
    expect(session.connected).toBe(true);
  });

  it('reconnects after the realtime session is lost, then speaks', async () => {
    sessionMocks.speakText.mockRejectedValueOnce(
      new Error('Volc realtime session is not connected'),
    );
    sessionMocks.speakText.mockResolvedValueOnce(undefined);
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Teach Newton.',
      speechRetry: instantRetry,
    });
    await session.connect();
    await session.speak('加速度与合力成正比。');
    expect(sessionMocks.connect).toHaveBeenCalledTimes(2);
    expect(sessionMocks.speakText).toHaveBeenCalledTimes(2);
    expect(session.connected).toBe(true);
  });

  it('does not retry when the learner cancels speech', async () => {
    sessionMocks.speakText.mockRejectedValueOnce(new Error('Volc model narration was interrupted'));
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Teach Newton.',
      speechRetry: instantRetry,
    });
    await session.connect();
    await expect(session.speak('这一句被打断。')).rejects.toThrow('interrupted');
    expect(sessionMocks.speakText).toHaveBeenCalledOnce();
  });

  it('cancels in-flight narration when answering without a playback hold', async () => {
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Teach Fourier analysis.',
    });
    await session.connect();
    await session.ask('为什么要拆成正弦波？');
    expect(sessionMocks.cancelNarration).toHaveBeenCalled();
    expect(sessionMocks.askQuestion).toHaveBeenCalledWith('为什么要拆成正弦波？', {
      requireAudio: true,
    });
  });

  it('freezes playback when the learner starts speaking', async () => {
    const interruptNode = vi.fn(async () => undefined);
    const resumeNode = vi.fn(async () => undefined);
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Teach Fourier analysis.',
      getLocation: () => ({ nodeId: 'node:intro', sceneId: 'scene-why' }),
      canInterrupt: () => true,
      interruptNode,
      resumeNode,
    });
    await session.connect();
    sessionMocks.onEvent?.({ type: 'learner_turn_started' });
    await vi.waitFor(() => expect(interruptNode).toHaveBeenCalledWith('node:intro'));
    sessionMocks.onEvent?.({ type: 'speaking', speaking: false });
    expect(resumeNode).not.toHaveBeenCalled();
    sessionMocks.onEvent?.({ type: 'audio_completed', hasAudio: true });
    await vi.waitFor(() => expect(resumeNode).toHaveBeenCalledWith('node:intro'));
  });

  it('waits for the interruption commit and real answer completion, not narration cancellation', async () => {
    let commit!: () => void;
    sessionMocks.cancelNarration.mockImplementation(async () => {
      sessionMocks.onEvent?.({ type: 'speaking', speaking: false });
    });
    const interruptNode = vi.fn(async () => {
      await sessionMocks.cancelNarration();
      await new Promise<void>((resolve) => {
        commit = resolve;
      });
    });
    const resumeNode = vi.fn(async () => undefined);
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Teach rates.',
      getLocation: () => ({ nodeId: 'node:rate', sceneId: 'rate' }),
      interruptNode,
      resumeNode,
    });
    await session.connect();
    sessionMocks.onEvent?.({ type: 'learner_turn_started' });
    await vi.waitFor(() => expect(commit).toBeTypeOf('function'));
    expect(resumeNode).not.toHaveBeenCalled();
    sessionMocks.onEvent?.({ type: 'audio_completed', hasAudio: true });
    await Promise.resolve();
    expect(resumeNode).not.toHaveBeenCalled();
    commit();
    await vi.waitFor(() => expect(resumeNode).toHaveBeenCalledExactlyOnceWith('node:rate'));
    await session.close();
  });

  it('keeps the interrupted node after an empty answer or failed resume so it can retry', async () => {
    const interruptNode = vi.fn(async () => undefined);
    const resumeNode = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error('Resume storage unavailable'));
    const events: Array<{ type: string }> = [];
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Teach rates.',
      getLocation: () => ({ nodeId: 'node:rate', sceneId: 'rate' }),
      interruptNode,
      resumeNode,
      onEvent: (event) => events.push(event),
    });
    await session.connect();
    sessionMocks.onEvent?.({ type: 'learner_turn_started' });
    await vi.waitFor(() => expect(interruptNode).toHaveBeenCalledOnce());
    sessionMocks.onEvent?.({ type: 'audio_completed', hasAudio: false });
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: 'error',
        error: expect.objectContaining({ message: expect.stringContaining('without audio') }),
      }),
    );
    expect(resumeNode).not.toHaveBeenCalled();
    sessionMocks.onEvent?.({ type: 'audio_completed', hasAudio: true });
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: 'error',
        error: expect.objectContaining({ message: 'Resume storage unavailable' }),
      }),
    );
    expect(events.filter((event) => event.type === 'node_resumed')).toHaveLength(0);
    sessionMocks.onEvent?.({ type: 'audio_completed', hasAudio: true });
    await vi.waitFor(() => expect(resumeNode).toHaveBeenCalledTimes(2));
    expect(events.filter((event) => event.type === 'node_resumed')).toHaveLength(1);
    await session.close();
  });

  it('does not resume after a typed answer fails and retries the same held node', async () => {
    const interruptNode = vi.fn(async () => undefined);
    const resumeNode = vi.fn(async () => undefined);
    sessionMocks.askQuestion.mockRejectedValueOnce(new Error('Teacher response failed'));
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Teach rates.',
      getLocation: () => ({ nodeId: 'node:rate', sceneId: 'rate' }),
      interruptNode,
      resumeNode,
      speechRetry: { ...instantRetry, maxRetries: 0 },
    });
    await session.connect();
    await expect(session.ask('Why?')).rejects.toThrow('Teacher response failed');
    expect(resumeNode).not.toHaveBeenCalled();
    await session.ask('Why?');
    expect(interruptNode).toHaveBeenCalledOnce();
    expect(resumeNode).toHaveBeenCalledExactlyOnceWith('node:rate');
    await session.close();
  });

  it('refreshes a reused session context before narration and typed questions', async () => {
    let instructions = 'Node A.';
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => instructions,
    });
    await session.connect();
    instructions = 'Node B.';
    await session.speak('Explain B.');
    expect(sessionMocks.updateInstructions).toHaveBeenLastCalledWith(
      buildRealtimeTeacherInstructions('Node B.'),
    );
    expect(sessionMocks.speakText).toHaveBeenLastCalledWith('Explain B.', { requireAudio: true });
    instructions = 'Node C.';
    await session.ask('Why here?');
    expect(sessionMocks.updateInstructions).toHaveBeenLastCalledWith(
      buildRealtimeTeacherInstructions('Node C.'),
    );
    expect(sessionMocks.askQuestion).toHaveBeenLastCalledWith('Why here?', { requireAudio: true });
    await session.close();
  });

  it('does not narrate if cancellation occurs while updating the node context', async () => {
    let instructions = 'Node A.';
    let updated!: () => void;
    const session = new VolcTeacherSpeechSession({ getInstructions: () => instructions });
    await session.connect();
    instructions = 'Node B.';
    sessionMocks.updateInstructions.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          updated = resolve;
        }),
    );
    const controller = new AbortController();
    const speaking = session.speak('Explain B.', { signal: controller.signal });
    const rejected = expect(speaking).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(updated).toBeTypeOf('function'));
    controller.abort();
    updated();
    await rejected;
    expect(sessionMocks.speakText).not.toHaveBeenCalled();
    await session.close();
  });

  it('does not cancel the new native answer when pausing the old authored narration', async () => {
    const controller = new AbortController();
    let rejectNarration!: (error: Error) => void;
    sessionMocks.speakText.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectNarration = reject;
        }),
    );
    const interruptNode = vi.fn(async () => controller.abort());
    const resumeNode = vi.fn(async () => undefined);
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Teach rates.',
      getLocation: () => ({ nodeId: 'node:rate', sceneId: 'rate' }),
      interruptNode,
      resumeNode,
      speechRetry: { ...instantRetry, maxRetries: 0 },
    });
    await session.connect();
    const narration = session.speak('The local rate changes.', { signal: controller.signal });
    const rejected = expect(narration).rejects.toThrow('interrupted');
    await vi.waitFor(() => expect(rejectNarration).toBeTypeOf('function'));
    rejectNarration(new Error('Volc model narration was interrupted'));
    sessionMocks.onEvent?.({ type: 'learner_turn_started' });
    await rejected;
    await vi.waitFor(() => expect(interruptNode).toHaveBeenCalledOnce());
    expect(sessionMocks.cancelNarration).not.toHaveBeenCalled();
    sessionMocks.onEvent?.({ type: 'audio_completed', hasAudio: true });
    await vi.waitFor(() => expect(resumeNode).toHaveBeenCalledOnce());
    await session.close();
  });

  it('re-freezes a stale resume and waits for the newer learner response', async () => {
    let resumed!: () => void;
    const interruptNode = vi.fn(async () => undefined);
    const resumeNode = vi
      .fn(async (): Promise<void> => undefined)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resumed = resolve;
          }),
      );
    const events: string[] = [];
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Teach rates.',
      getLocation: () => ({ nodeId: 'node:rate', sceneId: 'rate' }),
      interruptNode,
      resumeNode,
      onEvent: (event) => events.push(event.type),
    });
    await session.connect();
    sessionMocks.onEvent?.({ type: 'learner_turn_started' });
    sessionMocks.onEvent?.({ type: 'audio_completed', hasAudio: true });
    await vi.waitFor(() => expect(resumed).toBeTypeOf('function'));
    sessionMocks.onEvent?.({ type: 'learner_turn_started' });
    resumed();
    await vi.waitFor(() => expect(interruptNode).toHaveBeenCalledTimes(2));
    expect(events.filter((type) => type === 'node_resumed')).toHaveLength(0);
    sessionMocks.onEvent?.({ type: 'audio_completed', hasAudio: true });
    await vi.waitFor(() => expect(resumeNode).toHaveBeenCalledTimes(2));
    expect(events.filter((type) => type === 'node_resumed')).toHaveLength(1);
    await session.close();
  });

  it('keeps replay receive-only while still requiring real narration audio', async () => {
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
    const interruptNode = vi.fn(async () => undefined);
    const session = new VolcTeacherSpeechSession({
      getInstructions: () => 'Read-only replay.',
      readOnly: true,
      getLocation: () => ({ nodeId: 'node:rate', sceneId: 'rate' }),
      interruptNode,
    });
    await session.connect();
    expect(sessionMocks.captureMicrophone).toBe(false);
    await session.speak('Replay the explanation.');
    expect(sessionMocks.speakText).toHaveBeenLastCalledWith('Replay the explanation.', {
      requireAudio: true,
    });
    await expect(session.ask('Why?')).rejects.toThrow('Replay');
    await expect(
      session.question(
        { question: 'Why?', guidance: 'Explain.' },
        { hintText: 'Hint.', resumeText: 'Continue.' },
      ),
    ).rejects.toThrow('Replay');
    sessionMocks.onEvent?.({ type: 'learner_turn_started' });
    await Promise.resolve();
    expect(interruptNode).not.toHaveBeenCalled();
    expect(sessionMocks.askQuestion).not.toHaveBeenCalled();
    await session.close();
  });
});

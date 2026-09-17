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
  close: vi.fn(async () => undefined),
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
    sessionMocks.close.mockClear();
    sessionMocks.updateInstructions.mockReset().mockResolvedValue(undefined);
    sessionMocks.setInputEnabled.mockClear();
    sessionMocks.onEvent = undefined;
    sessionMocks.captureMicrophone = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
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
    expect(sessionMocks.updateInstructions).toHaveBeenLastCalledWith('Normal lesson instructions.');
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
    expect(sessionMocks.connect).toHaveBeenCalledWith('Teach photosynthesis.');
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
    expect(sessionMocks.updateInstructions).toHaveBeenLastCalledWith('Node B.');
    expect(sessionMocks.speakText).toHaveBeenLastCalledWith('Explain B.', { requireAudio: true });
    instructions = 'Node C.';
    await session.ask('Why here?');
    expect(sessionMocks.updateInstructions).toHaveBeenLastCalledWith('Node C.');
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

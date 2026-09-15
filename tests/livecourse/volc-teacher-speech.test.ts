import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionMocks = vi.hoisted(() => ({
  connect: vi.fn(async (_instructions: string) => undefined),
  preparePlayback: vi.fn(async () => undefined),
  speakText: vi.fn(async (_text: string) => undefined),
  askQuestion: vi.fn(async (_text: string) => undefined),
  cancelNarration: vi.fn(async () => undefined),
  mute: vi.fn(),
  close: vi.fn(async () => undefined),
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
    sessionMocks.speakText.mockClear();
    sessionMocks.askQuestion.mockClear();
    sessionMocks.cancelNarration.mockClear();
    sessionMocks.mute.mockClear();
    sessionMocks.close.mockClear();
    sessionMocks.onEvent = undefined;
    sessionMocks.captureMicrophone = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
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
    expect(sessionMocks.speakText).toHaveBeenCalledWith('叶绿体吸收光能。');

    await session.ask('什么是光反应？');
    expect(sessionMocks.askQuestion).toHaveBeenCalledWith('什么是光反应？');
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
    expect(sessionMocks.speakText).toHaveBeenCalledWith('先把波形拆成正弦波。');
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
    expect(sessionMocks.askQuestion).toHaveBeenCalledWith(
      '傅里叶变换和拉普拉斯变换有什么区别？',
    );
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
    expect(sessionMocks.speakText).toHaveBeenNthCalledWith(2, '力是改变运动的原因。');
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
    sessionMocks.speakText.mockRejectedValueOnce(
      new Error('Volc model narration was interrupted'),
    );
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
    expect(sessionMocks.askQuestion).toHaveBeenCalledWith('为什么要拆成正弦波？');
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
    await vi.waitFor(() => expect(resumeNode).toHaveBeenCalledWith('node:intro'));
  });
});

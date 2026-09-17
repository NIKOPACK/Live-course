import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRealtimeTeacherInstructions } from '@/lib/livecourse/realtime/teacher-instructions';

type FakeTool = {
  name: string;
  execute: (input: unknown, context: unknown, details: unknown) => Promise<string>;
};

const mocks = vi.hoisted(() => {
  class FakeAgent {
    static instances: FakeAgent[] = [];
    readonly tools: FakeTool[];
    readonly instructions: string;

    constructor(config: { tools?: FakeTool[]; instructions: string }) {
      this.tools = config.tools ?? [];
      this.instructions = config.instructions;
      FakeAgent.instances.push(this);
    }
  }

  class FakeTransport {
    static instances: FakeTransport[] = [];
    readonly options: unknown;
    readonly events: Record<string, unknown>[] = [];
    readonly configs: unknown[] = [];
    readonly messages: unknown[] = [];
    readonly handlers = new Map<string, (...args: unknown[]) => void>();

    constructor(options: unknown) {
      this.options = options;
      FakeTransport.instances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void): void {
      this.handlers.set(event, handler);
    }

    sendEvent(event: Record<string, unknown>): void {
      this.events.push(event);
    }

    updateSessionConfig(config: unknown): void {
      this.configs.push(config);
    }

    sendMessage(text: string, data: unknown, options: unknown): void {
      this.messages.push({ text, data, options });
    }
  }

  class FakeSession {
    static instances: FakeSession[] = [];
    readonly agent: FakeAgent;
    readonly options: unknown;
    readonly transport: FakeTransport;
    readonly handlers = new Map<string, (...args: unknown[]) => void>();
    connectOptions: unknown;
    muted = false;
    interruptCount = 0;
    closed = false;
    activeResponseId: string | null = null;

    constructor(agent: FakeAgent, options: { transport: FakeTransport }) {
      this.agent = agent;
      this.options = options;
      this.transport = options.transport;
      FakeSession.instances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void): void {
      this.handlers.set(event, handler);
    }

    async connect(options: unknown): Promise<void> {
      this.connectOptions = options;
    }

    emit(event: string, ...args: unknown[]): void {
      if (event === 'transport_event') {
        const value = args[0] as { type: string; response?: { id: string } };
        if (value.type === 'response.created') this.activeResponseId = value.response?.id ?? null;
        if (value.type === 'response.done' && value.response?.id === this.activeResponseId) {
          this.activeResponseId = null;
        }
      }
      this.handlers.get(event)?.(...args);
    }

    mute(value: boolean): void {
      this.muted = value;
    }

    interrupt(): void {
      this.interruptCount += 1;
    }

    close(): void {
      this.closed = true;
    }
  }

  return { FakeAgent, FakeTransport, FakeSession };
});

vi.mock('@openai/agents/realtime', () => ({
  RealtimeAgent: mocks.FakeAgent,
  OpenAIRealtimeWebRTC: mocks.FakeTransport,
  RealtimeSession: mocks.FakeSession,
  tool: (options: unknown) => options,
}));

import {
  LiveCourseRealtimeSession,
  RealtimeHttpError,
  RealtimeInterruptionUncertaintyError,
  RealtimeSessionClosingError,
  type RealtimeTeacherEvent,
} from '@/lib/livecourse/realtime/client/session';
import type { RealtimeTeachingCommand } from '@/lib/livecourse/realtime/contracts';

class TestAudioBridge {
  audioElement = Object.assign(new EventTarget(), {
    play: vi.fn(async () => undefined),
  }) as unknown as HTMLAudioElement;
  inputTrack = { kind: 'audio', enabled: true, stop: vi.fn() };
  context = {
    createMediaStreamDestination: vi.fn(() => ({
      stream: { getAudioTracks: () => [this.inputTrack] },
    })),
  } as unknown as AudioContext;
  activated = 0;
  closed = 0;

  async activate(): Promise<void> {
    this.activated += 1;
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function flushRealtime(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function startResponse(fake: InstanceType<typeof mocks.FakeSession>, id?: string) {
  const request = fake.transport.events.filter((event) => event.type === 'response.create').at(-1);
  if (!request) throw new Error('No response request was sent');
  const config = request.response as { metadata: Record<string, string> };
  const responseId = id ?? `response-${config.metadata.livecourse_request}`;
  fake.emit('transport_event', {
    type: 'response.created',
    response: { id: responseId, metadata: config.metadata },
  });
  fake.emit('transport_event', { type: 'output_audio_buffer.started', response_id: responseId });
  return responseId;
}

function finishResponse(
  fake: InstanceType<typeof mocks.FakeSession>,
  id: string,
  { drain = true, status = 'completed', audio = true } = {},
) {
  fake.emit('transport_event', {
    type: 'response.done',
    response: {
      id,
      status,
      output: audio
        ? [{ type: 'message', content: [{ type: 'audio', transcript: 'Answer' }] }]
        : [],
    },
  });
  // The installed SDK emits this on response.done, before WebRTC audio drain.
  fake.emit('audio_stopped');
  if (drain) fake.emit('transport_event', { type: 'output_audio_buffer.stopped', response_id: id });
}

async function startAnswer(
  session: LiveCourseRealtimeSession,
  fake: InstanceType<typeof mocks.FakeSession>,
) {
  const completion = session.ask('Please explain that.');
  void completion.catch(() => undefined);
  if (fake.activeResponseId) {
    finishResponse(fake, fake.activeResponseId, { status: 'cancelled', drain: false });
  }
  await flushRealtime();
  return { completion, id: startResponse(fake) };
}

function setup(
  options: {
    canInterrupt?: () => boolean;
    interruptNode?: (nodeId: string) => Promise<void>;
    resumeNode?: (nodeId: string) => Promise<void>;
    onEvent?: (event: RealtimeTeacherEvent) => void;
    getClientSecretApiKey?: () => string | undefined;
    getTeachingContext?: () => string;
    readOnly?: boolean;
    cancelAssistantTasks?: () => Promise<void>;
  } = {},
) {
  mocks.FakeAgent.instances.length = 0;
  mocks.FakeTransport.instances.length = 0;
  mocks.FakeSession.instances.length = 0;

  const bridge = new TestAudioBridge();
  const events: RealtimeTeacherEvent[] = [];
  const commands: RealtimeTeachingCommand[] = [];
  const resumed: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/client-secret')) {
      return response({
        value: 'ek_test',
        expiresAt: 1_900_000_000,
        model: 'gpt-realtime-2.1',
        voice: 'marin',
      });
    }
    if (url.endsWith('/tools')) {
      return response({
        success: true,
        command: {
          nodeId: 'node:scene-1',
          idempotencyKey: 'realtime:call-1',
          type: 'lesson.goto_node',
          payload: { targetNodeId: 'node:scene-2' },
        },
        message: 'accepted',
      });
    }
    throw new Error(`unexpected URL ${url}`);
  });

  const session = new LiveCourseRealtimeSession({
    courseId: 'course-1',
    lessonId: 'lesson-1',
    learnerId: 'learner-1',
    readOnly: options.readOnly,
    cancelAssistantTasks: options.cancelAssistantTasks,
    audioBridge: bridge as never,
    getLocation: () => ({ nodeId: 'node:scene-1', sceneId: 'scene-1' }),
    getTeachingContext: options.getTeachingContext ?? (() => 'Scene context'),
    dispatchCommand: async (command) => {
      commands.push(command);
    },
    canInterrupt: options.canInterrupt,
    interruptNode: options.interruptNode ?? (async () => undefined),
    resumeNode:
      options.resumeNode ??
      (async (nodeId) => {
        resumed.push(nodeId);
      }),
    onEvent: (event) => {
      events.push(event);
      options.onEvent?.(event);
    },
    getClientSecretApiKey: options.getClientSecretApiKey,
    fetchImpl,
  });

  return { bridge, events, commands, resumed, fetchImpl, session };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('LiveCourseRealtimeSession', () => {
  it('conducts oral voice and typed rounds without resuming the lecture before audio drains', async () => {
    const interruptNode = vi.fn();
    const state = setup({
      interruptNode,
      getTeachingContext: () =>
        'Prepared teaching content:\nThe next sentence explains the derivative.',
    });
    await state.session.connect();
    const fake = mocks.FakeSession.instances[0];
    const completion = state.session.question(
      { question: 'Why does the rate change?', guidance: 'Consider the local slope.' },
      {
        hintText: 'Give a hint.',
        resumeText: 'Continue.',
      },
    );
    await flushRealtime();
    const initial = startResponse(fake);
    finishResponse(fake, initial, { drain: false });
    await flushRealtime();
    expect(state.events.filter((event) => event.type === 'oral_question').at(-1)).toMatchObject({
      state: { phase: 'asking' },
    });
    fake.emit('transport_event', { type: 'output_audio_buffer.stopped', response_id: initial });
    await flushRealtime();
    expect(fake.muted).toBe(false);
    for (let round = 0; round < 3; round++) {
      let answering: Promise<void> | undefined;
      if (round === 0) {
        fake.emit('transport_event', {
          type: 'input_audio_buffer.speech_started',
          item_id: 'oral-input',
        });
        fake.emit('transport_event', {
          type: 'input_audio_buffer.speech_started',
          item_id: 'oral-input',
        });
        fake.emit('transport_event', {
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: 'oral-input',
          transcript: 'The local rate is changing.',
        });
      } else answering = state.session.ask(`Typed reasoning ${round}`);
      await flushRealtime();
      const id = startResponse(fake);
      const request = fake.transport.events
        .filter((event) => event.type === 'response.create')
        .at(-1);
      expect(request).toMatchObject({
        response: {
          instructions: expect.stringContaining(
            round === 2 ? 'final answer round' : 'short oral dialogue',
          ),
        },
      });
      const oralInstructions = (request as { response: { instructions: string } }).response
        .instructions;
      expect(oralInstructions).not.toContain('Prepared teaching content');
      expect(oralInstructions).not.toContain('The next sentence explains the derivative.');
      const oralConfig = fake.transport.configs.at(-1) as { instructions: string };
      expect(oralConfig.instructions).toContain('short oral dialogue');
      expect(oralConfig.instructions).not.toContain('Prepared teaching content');
      fake.emit('transport_event', {
        type: 'response.output_audio_transcript.done',
        response_id: id,
        transcript: `Feedback and question ${round}`,
      });
      finishResponse(fake, id);
      await answering;
      await flushRealtime();
      expect(interruptNode).not.toHaveBeenCalled();
      expect(state.resumed).toEqual([]);
    }
    await completion;
    expect(fake.transport.messages).toHaveLength(2);
    expect(state.events.filter((event) => event.type === 'oral_question').at(-1)).toMatchObject({
      state: null,
    });
    await state.session.close();
  });

  it('preserves a muted microphone when leaving oral dialogue', async () => {
    const state = setup();
    await state.session.connect();
    state.session.mute(true);
    const fake = mocks.FakeSession.instances[0];
    const controller = new AbortController();
    const completion = state.session.question(
      { question: 'Why?', guidance: 'Reason about the rate.' },
      {
        hintText: 'Hint.',
        resumeText: 'Continue.',
        signal: controller.signal,
      },
    );
    void completion.catch(() => undefined);
    await flushRealtime();
    finishResponse(fake, startResponse(fake));
    await flushRealtime();
    expect(fake.muted).toBe(true);
    controller.abort();
    await expect(completion).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.muted).toBe(true);
    await state.session.close();
  });
  it('connects without requesting speech or publishing a fake completion', async () => {
    const state = setup();
    await state.session.connect();
    expect(mocks.FakeSession.instances[0].transport.events).toEqual([]);
    expect(state.events).toEqual([
      { type: 'status', status: 'connecting' },
      { type: 'status', status: 'connected' },
    ]);
  });

  it('reads each supplied script faithfully with fresh context and valid audio mode', async () => {
    let context = 'Current node one';
    const state = setup({ getTeachingContext: () => context });
    await state.session.connect();
    const fake = mocks.FakeSession.instances[0];

    context = 'Current node two';
    const first = state.session.speak('Read this exact sentence.');
    const request = fake.transport.events.at(-1);
    expect(request).toMatchObject({
      type: 'response.create',
      response: {
        instructions: expect.stringContaining('Current node two'),
        output_modalities: ['audio'],
        conversation: 'none',
        tools: [],
        tool_choice: 'none',
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'Read this exact sentence.' }],
          },
        ],
      },
    });
    expect(JSON.stringify(request)).toContain('Read the supplied lesson script faithfully');
    expect(fake.transport.messages).toEqual([]);
    finishResponse(fake, startResponse(fake));
    await first;

    context = 'Current node three';
    const second = state.session.speak('The next sentence.');
    expect(fake.transport.configs.at(-1)).toMatchObject({
      instructions: expect.stringContaining('Current node three'),
      outputModalities: ['audio'],
      audio: {
        input: {
          transcription: { model: 'gpt-4o-mini-transcribe' },
          turnDetection: { createResponse: false, interruptResponse: false },
        },
        output: { voice: 'marin' },
      },
    });
    finishResponse(fake, startResponse(fake));
    await second;
  });

  it('requires successful exact-response completion and actual audio drain', async () => {
    const state = setup();
    await state.session.connect();
    const fake = mocks.FakeSession.instances[0];
    let settled = false;
    const speech = state.session.speak('Audio must finish.').then(() => {
      settled = true;
    });
    const id = startResponse(fake);
    finishResponse(fake, id, { drain: false });
    fake.emit('transport_event', { type: 'output_audio_buffer.stopped', response_id: 'unrelated' });
    await flushRealtime();
    expect(settled).toBe(false);
    fake.emit('transport_event', { type: 'output_audio_buffer.stopped', response_id: id });
    await speech;
    expect(settled).toBe(true);
  });

  it('does not resolve when audio drain arrives before response success', async () => {
    const state = setup();
    await state.session.connect();
    const fake = mocks.FakeSession.instances[0];
    let settled = false;
    const speech = state.session.speak('Audio alone is insufficient.').then(() => {
      settled = true;
    });
    const id = startResponse(fake);
    fake.emit('transport_event', { type: 'output_audio_buffer.stopped', response_id: id });
    await flushRealtime();
    expect(settled).toBe(false);
    finishResponse(fake, id, { drain: false });
    await speech;
  });

  it.each(['failed', 'cancelled', 'incomplete'])('rejects a %s response', async (status) => {
    const state = setup();
    await state.session.connect();
    const fake = mocks.FakeSession.instances[0];
    const speech = state.session.speak('Original sentence');
    const rejected = expect(speech).rejects.toThrow(status);
    finishResponse(fake, startResponse(fake), { status });
    await rejected;
  });

  it('rejects a successful provider response that contains no audio', async () => {
    const state = setup();
    await state.session.connect();
    const fake = mocks.FakeSession.instances[0];
    const speech = state.session.speak('Original sentence');
    const rejected = expect(speech).rejects.toThrow('without audio');
    finishResponse(fake, startResponse(fake), { audio: false });
    await rejected;
  });

  it('rejects when browser audio playback is blocked', async () => {
    const state = setup();
    vi.mocked(state.bridge.audioElement.play).mockRejectedValue(new Error('autoplay blocked'));
    await state.session.connect();
    const fake = mocks.FakeSession.instances[0];
    const speech = state.session.speak('Original sentence');
    const rejected = expect(speech).rejects.toThrow('autoplay blocked');
    finishResponse(fake, startResponse(fake));
    await rejected;
  });

  it.each(['provider', 'transport', 'media', 'close'])(
    'rejects pending speech on %s failure',
    async (failure) => {
      const state = setup();
      await state.session.connect();
      const fake = mocks.FakeSession.instances[0];
      const speech = state.session.speak('Original sentence');
      const rejected = expect(speech).rejects.toThrow();
      startResponse(fake);
      if (failure === 'provider') fake.emit('error', { error: new Error('provider unavailable') });
      if (failure === 'transport')
        fake.transport.handlers.get('connection_change')?.('disconnected');
      if (failure === 'media') state.bridge.audioElement.dispatchEvent(new Event('error'));
      if (failure === 'close') await state.session.close();
      await rejected;
    },
  );

  it('rejects request and missing-drain timeouts rather than treating timers as success', async () => {
    vi.useFakeTimers();
    const state = setup();
    await state.session.connect();
    const fake = mocks.FakeSession.instances[0];
    const noResponse = state.session.speak('No response');
    const firstFailure = expect(noResponse).rejects.toThrow('did not start');
    await vi.advanceTimersByTimeAsync(30_000);
    await firstFailure;
    finishResponse(fake, startResponse(fake), { status: 'cancelled' });

    const noDrain = state.session.speak('No audio drain');
    const secondFailure = expect(noDrain).rejects.toThrow('timed out');
    finishResponse(fake, startResponse(fake), { drain: false });
    await vi.advanceTimersByTimeAsync(180_000);
    await secondFailure;
  });

  it('does not capture an interruption from an engine abort or SDK cancellation echo', async () => {
    const interruptNode = vi.fn(async () => undefined);
    const state = setup({ interruptNode });
    await state.session.connect();
    const fake = mocks.FakeSession.instances[0];
    const controller = new AbortController();
    const speech = state.session.speak('Incomplete sentence', { signal: controller.signal });
    const rejected = expect(speech).rejects.toMatchObject({ name: 'AbortError' });
    const id = startResponse(fake);
    controller.abort();
    fake.emit('audio_interrupted');
    finishResponse(fake, id);
    await rejected;
    expect(interruptNode).not.toHaveBeenCalled();
    expect(state.resumed).toEqual([]);
  });

  it('never lets cancelled narration events finish a newer answer or cancel it via an old signal', async () => {
    const controller = new AbortController();
    const interruptNode = vi.fn(async () => controller.abort());
    const state = setup({ interruptNode });
    await state.session.connect();
    const fake = mocks.FakeSession.instances[0];
    const speech = state.session.speak('Original sentence', { signal: controller.signal });
    const rejected = expect(speech).rejects.toMatchObject({ name: 'AbortError' });
    const narrationId = startResponse(fake);
    const answer = await startAnswer(state.session, fake);
    const eventCount = fake.transport.events.length;
    controller.abort();
    fake.emit('audio_interrupted');
    finishResponse(fake, narrationId);
    await rejected;
    await flushRealtime();
    expect(fake.transport.events).toHaveLength(eventCount);
    expect(state.resumed).toEqual([]);
    expect(interruptNode).toHaveBeenCalledOnce();
    finishResponse(fake, answer.id);
    await answer.completion;
    expect(state.resumed).toEqual(['node:scene-1']);
  });

  it('cancels a narration that is created late without assigning it to a newer request', async () => {
    const state = setup();
    await state.session.connect();
    const fake = mocks.FakeSession.instances[0];
    const controller = new AbortController();
    const first = state.session.speak('Cancelled before creation', { signal: controller.signal });
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const oldRequest = fake.transport.events.at(-1)?.response as {
      metadata: Record<string, string>;
    };
    controller.abort();
    await rejected;
    const next = state.session.speak('New sentence');
    expect(fake.transport.events.filter((event) => event.type === 'response.create')).toHaveLength(
      1,
    );
    fake.emit('transport_event', {
      type: 'response.created',
      response: { id: 'late-old-response', metadata: oldRequest.metadata },
    });
    expect(fake.transport.events.at(-1)).toEqual({
      type: 'response.cancel',
      response_id: 'late-old-response',
    });
    finishResponse(fake, 'late-old-response', { status: 'cancelled' });
    await flushRealtime();
    const id = startResponse(fake);
    finishResponse(fake, id);
    await next;
  });

  it('waits for the SDK-ready response boundary before sending a learner answer', async () => {
    const state = setup();
    await state.session.connect();
    const fake = mocks.FakeSession.instances[0];
    const speech = state.session.speak('Original narration');
    const rejected = expect(speech).rejects.toMatchObject({ name: 'AbortError' });
    const oldId = startResponse(fake);
    const answer = state.session.ask('A learner question');
    await rejected;
    await flushRealtime();
    expect(fake.transport.events.filter((event) => event.type === 'response.create')).toHaveLength(
      1,
    );
    finishResponse(fake, oldId, { status: 'cancelled', drain: false });
    // The next send must wait until the SDK's raw-event callback has returned.
    expect(fake.transport.events.filter((event) => event.type === 'response.create')).toHaveLength(
      1,
    );
    await flushRealtime();
    expect(fake.transport.events.filter((event) => event.type === 'response.create')).toHaveLength(
      2,
    );
    const id = startResponse(fake);
    let completed = false;
    void answer.then(() => {
      completed = true;
    });
    fake.emit('transport_event', { type: 'output_audio_buffer.stopped', response_id: oldId });
    fake.emit('audio_stopped');
    finishResponse(fake, id, { drain: false });
    await flushRealtime();
    expect(completed).toBe(false);
    expect(state.resumed).toEqual([]);
    fake.emit('transport_event', { type: 'output_audio_buffer.stopped', response_id: id });
    await answer;
    expect(state.resumed).toEqual(['node:scene-1']);
  });

  it('provides receive-only replay without microphone capture, tools, or classroom mutations', async () => {
    const interruptNode = vi.fn(async () => undefined);
    const cancelAssistantTasks = vi.fn(async () => undefined);
    const state = setup({ readOnly: true, interruptNode, cancelAssistantTasks });
    await state.session.connect();
    const fake = mocks.FakeSession.instances[0];
    expect(fake.agent.tools).toEqual([]);
    expect(fake.muted).toBe(true);
    expect(state.bridge.inputTrack.enabled).toBe(false);
    const transport = mocks.FakeTransport.instances[0].options as {
      mediaStream: MediaStream;
      changePeerConnection: (connection: RTCPeerConnection) => RTCPeerConnection;
    };
    expect(transport.mediaStream.getAudioTracks()).toEqual([state.bridge.inputTrack]);
    const transceiver = { sender: { track: state.bridge.inputTrack }, direction: 'sendrecv' };
    const connection = { getTransceivers: () => [transceiver] } as unknown as RTCPeerConnection;
    expect(transport.changePeerConnection(connection)).toBe(connection);
    expect(transceiver.direction).toBe('recvonly');
    expect(fake.options).toMatchObject({
      config: { audio: { input: { transcription: null, turnDetection: null } } },
    });
    expect(() => state.session.mute(false)).toThrow('cannot be enabled');
    await expect(state.session.ask('No questions in replay')).rejects.toThrow('not available');
    fake.emit('transport_event', { type: 'input_audio_buffer.speech_started', item_id: 'ignored' });
    fake.emit('transport_event', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'ignored',
      transcript: 'Ignored input',
    });
    const narration = state.session.speak('Replay this original sentence.');
    finishResponse(fake, startResponse(fake));
    await narration;
    expect(fake.transport.configs.at(-1)).toMatchObject({
      audio: { input: { transcription: null, turnDetection: null } },
    });
    expect(interruptNode).not.toHaveBeenCalled();
    expect(state.commands).toEqual([]);
    expect(state.resumed).toEqual([]);
    expect(state.fetchImpl).toHaveBeenCalledOnce();
    expect(state.events).not.toContainEqual(
      expect.objectContaining({ type: 'transcript', speaker: 'student' }),
    );
    await state.session.close();
    expect(cancelAssistantTasks).not.toHaveBeenCalled();
  });

  it('releases a rejected response-create boundary and surfaces the provider message', async () => {
    const state = setup();
    await state.session.connect();
    const fake = mocks.FakeSession.instances[0];
    const first = state.session.speak('First attempt');
    const rejected = expect(first).rejects.toThrow('provider refused the response');
    const request = fake.transport.events.at(-1);
    fake.emit('error', {
      error: {
        type: 'error',
        error: { event_id: request?.event_id, message: 'provider refused the response' },
      },
    });
    await rejected;
    const retry = state.session.speak('Retry');
    expect(fake.transport.events.filter((event) => event.type === 'response.create')).toHaveLength(
      2,
    );
    finishResponse(fake, startResponse(fake));
    await retry;
  });

  it('uses microphone transcription to answer once and resume only after answer playback', async () => {
    const interruptNode = vi.fn(async () => undefined);
    let context = 'Before the question';
    const state = setup({ interruptNode, getTeachingContext: () => context });
    await state.session.connect();
    const fake = mocks.FakeSession.instances[0];
    fake.emit('transport_event', { type: 'input_audio_buffer.speech_started', item_id: 'mic-1' });
    context = 'Context at the question';
    fake.emit('transport_event', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'mic-1',
      transcript: 'Why is this true?',
    });
    await flushRealtime();
    expect(interruptNode).toHaveBeenCalledOnce();
    expect(fake.transport.messages).toEqual([]);
    expect(fake.transport.configs.at(-1)).toMatchObject({
      instructions: buildRealtimeTeacherInstructions('Context at the question'),
    });
    const id = startResponse(fake);
    finishResponse(fake, id, { drain: false });
    await flushRealtime();
    expect(state.resumed).toEqual([]);
    fake.emit('transport_event', { type: 'output_audio_buffer.stopped', response_id: id });
    await flushRealtime();
    expect(state.resumed).toEqual(['node:scene-1']);
  });

  it('preserves the text-question resume point and rejects when resuming fails', async () => {
    const interruptNode = vi.fn(async () => undefined);
    const resumeNode = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error('resume failed'));
    const state = setup({ interruptNode, resumeNode });
    await state.session.connect();
    const fake = mocks.FakeSession.instances[0];
    const first = await startAnswer(state.session, fake);
    finishResponse(fake, first.id);
    await expect(first.completion).rejects.toThrow('resume failed');
    const second = await startAnswer(state.session, fake);
    finishResponse(fake, second.id);
    await second.completion;
    expect(interruptNode).toHaveBeenCalledOnce();
    expect(resumeNode).toHaveBeenNthCalledWith(2, 'node:scene-1');
    expect(fake.transport.messages).toContainEqual({
      text: 'Please explain that.',
      data: {},
      options: { triggerResponse: false },
    });
  });

  it('does not let VAD create automatic answers while interruptions are unavailable', async () => {
    const state = setup({ canInterrupt: () => false });
    await state.session.connect();
    const fake = mocks.FakeSession.instances[0];
    expect(fake.options).toMatchObject({
      config: {
        audio: {
          input: {
            transcription: { model: 'gpt-4o-mini-transcribe' },
            turnDetection: { createResponse: false, interruptResponse: false },
          },
        },
      },
    });
    fake.emit('transport_event', { type: 'input_audio_buffer.speech_started', item_id: 'blocked' });
    fake.emit('transport_event', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'blocked',
      transcript: 'Question while paused',
    });
    await flushRealtime();
    await expect(state.session.ask('Text while paused')).rejects.toThrow('not available');
    expect(fake.transport.events).toEqual([]);
  });

  it('does not accept a new question while a retained interruption has been explicitly paused', async () => {
    let canInterrupt = true;
    const state = setup({ canInterrupt: () => canInterrupt });
    await state.session.connect();
    const fake = mocks.FakeSession.instances[0];
    fake.emit('transport_event', { type: 'input_audio_buffer.speech_started', item_id: 'first' });
    canInterrupt = false;
    fake.emit('transport_event', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'first',
      transcript: 'Too late after pause',
    });
    await flushRealtime();
    fake.emit('transport_event', { type: 'input_audio_buffer.speech_started', item_id: 'paused' });
    fake.emit('transport_event', {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'paused',
      transcript: 'Still paused',
    });
    await flushRealtime();
    await expect(state.session.ask('Still paused')).rejects.toThrow('not available');
    expect(fake.transport.events).toEqual([]);
    expect(state.resumed).toEqual([]);
    canInterrupt = true;
    const answer = await startAnswer(state.session, fake);
    finishResponse(fake, answer.id);
    await answer.completion;
    expect(state.resumed).toEqual(['node:scene-1']);
  });

  it('keeps a failed text answer retryable at the original frozen node', async () => {
    const interruptNode = vi.fn(async () => undefined);
    const state = setup({ interruptNode });
    await state.session.connect();
    const fake = mocks.FakeSession.instances[0];
    const first = await startAnswer(state.session, fake);
    finishResponse(fake, first.id, { status: 'failed' });
    await expect(first.completion).rejects.toThrow('failed');
    expect(state.resumed).toEqual([]);
    const retry = await startAnswer(state.session, fake);
    expect(
      fake.transport.events.filter((event) => event.type === 'response.create').at(-1),
    ).toMatchObject({
      response: {
        instructions: buildRealtimeTeacherInstructions('Scene context'),
      },
    });
    finishResponse(fake, retry.id);
    await retry.completion;
    expect(interruptNode).toHaveBeenCalledOnce();
    expect(state.resumed).toEqual(['node:scene-1']);
  });

  it('rejects unconnected speech and text instead of falling back to silent reading', async () => {
    const state = setup();
    await expect(state.session.speak('A lesson')).rejects.toThrow('not connected');
    await expect(state.session.ask('A question')).rejects.toThrow('not connected');
    expect(state.events).toEqual([]);
  });

  it('uses the server-issued secret and explicit WebRTC audio element', async () => {
    const setupState = setup();
    await setupState.session.connect();

    expect(setupState.bridge.activated).toBe(1);
    expect(setupState.fetchImpl).toHaveBeenCalledWith(
      '/api/livecourse/realtime/client-secret',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-learner-key': 'learner-1' }),
      }),
    );
    expect(mocks.FakeTransport.instances[0]?.options).toEqual({
      audioElement: setupState.bridge.audioElement,
    });
    expect(mocks.FakeSession.instances[0]?.connectOptions).toEqual({
      apiKey: 'ek_test',
      model: 'gpt-realtime-2.1',
    });
    expect(setupState.events).toContainEqual({ type: 'status', status: 'connected' });
    const [, init] = setupState.fetchImpl.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      courseId: 'course-1',
      lessonId: 'lesson-1',
    });
  });

  it('forwards a learner-saved Realtime key only in the client-secret request', async () => {
    const setupState = setup({ getClientSecretApiKey: () => 'sk-from-settings' });
    await setupState.session.connect();

    const [, init] = setupState.fetchImpl.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      courseId: 'course-1',
      lessonId: 'lesson-1',
      apiKey: 'sk-from-settings',
    });
    expect(mocks.FakeSession.instances[0]?.connectOptions).toEqual({
      apiKey: 'ek_test',
      model: 'gpt-realtime-2.1',
    });
  });

  it('does not retain a stale connect promise when a connecting callback closes the session', async () => {
    let closePromise: Promise<void> | null = null;
    let closedFromConnecting = false;
    const setupState = setup({
      onEvent: (event) => {
        if (event.type === 'status' && event.status === 'connecting' && !closedFromConnecting) {
          closedFromConnecting = true;
          closePromise = setupState.session.close();
        }
      },
    });

    const firstConnect = setupState.session.connect();
    await expect(firstConnect).rejects.toBeInstanceOf(RealtimeSessionClosingError);
    await expect(closePromise).resolves.toBeUndefined();

    // The synchronous status callback ran before connect() had assigned its
    // promise identity. A later retry must not see that stale identity and
    // must establish a new transport.
    await expect(setupState.session.connect()).resolves.toBeUndefined();
    expect(mocks.FakeSession.instances).toHaveLength(1);
    expect(setupState.session.connected).toBe(true);
  });

  it('allows a close callback to reconnect after a synchronous connecting notification', async () => {
    let reconnectPromise: Promise<void> | null = null;
    let closeStarted = false;
    const setupState = setup({
      onEvent: (event) => {
        if (event.type === 'status' && event.status === 'connecting' && !closeStarted) {
          closeStarted = true;
          const closePromise = setupState.session.close();
          reconnectPromise = closePromise.then(() => setupState.session.connect());
        }
      },
    });

    await expect(setupState.session.connect()).rejects.toBeInstanceOf(RealtimeSessionClosingError);
    await expect(reconnectPromise).resolves.toBeUndefined();
    expect(setupState.session.connected).toBe(true);
    expect(mocks.FakeSession.instances).toHaveLength(1);
  });

  it('routes a tool call through the strict BFF and returns its command to the controller', async () => {
    const setupState = setup();
    await setupState.session.connect();
    const fake = mocks.FakeSession.instances[0];
    const gotoTool = fake.agent.tools.find((candidate) => candidate.name === 'goto_node');
    expect(gotoTool).toBeDefined();
    if (!gotoTool) throw new Error('goto_node tool was not registered');

    await expect(
      gotoTool.execute({ targetNodeId: 'node:scene-2' }, undefined, {
        toolCall: { callId: 'call-1' },
      }),
    ).resolves.toBe('accepted');
    expect(setupState.commands).toEqual([
      {
        nodeId: 'node:scene-1',
        idempotencyKey: 'realtime:call-1',
        type: 'lesson.goto_node',
        payload: { targetNodeId: 'node:scene-2' },
      },
    ]);
  });

  it('does not dispatch a tool result from an earlier connection after reconnect', async () => {
    let releaseTool!: (value: Response) => void;
    const toolResponse = new Promise<Response>((resolve) => {
      releaseTool = resolve;
    });
    const setupState = setup();
    setupState.fetchImpl.mockImplementation(async (input) => {
      if (String(input).endsWith('/tools')) return toolResponse;
      return response({
        value: 'ek_test',
        expiresAt: 1_900_000_000,
        model: 'gpt-realtime-2.1',
        voice: 'marin',
      });
    });

    await setupState.session.connect();
    const first = mocks.FakeSession.instances[0];
    if (!first) throw new Error('first realtime session was not created');
    const gotoTool = first.agent.tools.find((candidate) => candidate.name === 'goto_node');
    if (!gotoTool) throw new Error('goto_node tool was not registered');

    const toolPromise = gotoTool.execute({ targetNodeId: 'node:scene-2' }, undefined, {
      toolCall: { callId: 'stale-call' },
    });
    await flushRealtime();

    await setupState.session.close();
    await setupState.session.connect();
    releaseTool(
      response({
        success: true,
        command: {
          nodeId: 'node:scene-1',
          idempotencyKey: 'realtime:stale-call',
          type: 'lesson.goto_node',
          payload: { targetNodeId: 'node:scene-2' },
        },
        message: 'accepted',
      }),
    );

    await expect(toolPromise).rejects.toBeInstanceOf(RealtimeSessionClosingError);
    expect(setupState.commands).toEqual([]);
  });

  it('interrupts immediately and resumes the interrupted node after the answer ends', async () => {
    const setupState = setup();
    await setupState.session.connect();
    const fake = mocks.FakeSession.instances[0];

    const narration = setupState.session.speak('Original lesson');
    void narration.catch(() => undefined);
    startResponse(fake);
    fake.emit('transport_event', { type: 'input_audio_buffer.speech_started' });
    const answer = await startAnswer(setupState.session, fake);
    finishResponse(fake, answer.id);
    await flushRealtime();

    await expect(narration).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.transport.events).toContainEqual(
      expect.objectContaining({ type: 'response.cancel' }),
    );
    expect(setupState.events).toContainEqual({ type: 'audio_interrupted' });
    expect(setupState.resumed).toEqual(['node:scene-1']);
  });

  it('captures learner VAD while the realtime teacher is silent', async () => {
    const setupState = setup();
    await setupState.session.connect();
    const fake = mocks.FakeSession.instances[0];

    // The lesson narrator is a separate PlaybackEngine. Realtime itself can
    // be silent while that narrator is speaking, so VAD must still freeze the
    // classroom resume point instead of being gated by realtime #speaking.
    fake.emit('transport_event', { type: 'input_audio_buffer.speech_started' });

    expect(setupState.events).toContainEqual({ type: 'interrupted', nodeId: 'node:scene-1' });
    expect(fake.interruptCount).toBe(0);
  });

  it('does not capture learner VAD while the classroom is paused', async () => {
    const interruptNode = vi.fn(async () => undefined);
    const setupState = setup({ canInterrupt: () => false, interruptNode });
    await setupState.session.connect();
    const fake = mocks.FakeSession.instances[0];

    fake.emit('transport_event', { type: 'input_audio_buffer.speech_started' });

    expect(interruptNode).not.toHaveBeenCalled();
    expect(setupState.events).not.toContainEqual(expect.objectContaining({ type: 'interrupted' }));
  });

  it('does not resume a paused local playback when interruption is rejected', async () => {
    const interruptNode = vi.fn(async () => {
      throw new Error('paused classroom');
    });
    const setupState = setup({ canInterrupt: () => false, interruptNode });
    await setupState.session.connect();
    const fake = mocks.FakeSession.instances[0];

    fake.emit('transport_event', { type: 'input_audio_buffer.speech_started' });

    expect(interruptNode).not.toHaveBeenCalled();
  });

  it('emits a dedicated recognition failure event after freezing the resume point', async () => {
    const setupState = setup();
    await setupState.session.connect();
    const fake = mocks.FakeSession.instances[0];

    fake.emit('transport_event', { type: 'input_audio_buffer.speech_started' });
    fake.emit('transport_event', {
      type: 'conversation.item.input_audio_transcription.failed',
      error: { code: 'audio_unintelligible', message: 'could not transcribe' },
    });

    expect(setupState.events).toContainEqual(
      expect.objectContaining({ type: 'recognition_failed' }),
    );
    expect(setupState.events).toContainEqual({ type: 'interrupted', nodeId: 'node:scene-1' });
  });

  it('retains an uncertain interruption until resume can reconcile the same transaction', async () => {
    const setupState = setup({
      interruptNode: async (nodeId) => {
        throw new RealtimeInterruptionUncertaintyError(
          nodeId,
          new Error('append response and reconciliation were both lost'),
        );
      },
    });
    await setupState.session.connect();
    const fake = mocks.FakeSession.instances[0];

    fake.emit('transport_event', { type: 'input_audio_buffer.speech_started' });
    await flushRealtime();

    expect(setupState.events).toContainEqual(
      expect.objectContaining({
        type: 'interruption_uncertain',
        nodeId: 'node:scene-1',
      }),
    );
    expect(setupState.events).not.toContainEqual(
      expect.objectContaining({ type: 'interruption_failed' }),
    );

    // `resumeNode` owns reconciliation of the retained interrupt key before it
    // writes the explicit resume command. Clearing the point here would make
    // the uncertain W/local boundary impossible to converge.
    const answer = await startAnswer(setupState.session, fake);
    finishResponse(fake, answer.id);
    await flushRealtime();
    expect(setupState.resumed).toEqual(['node:scene-1']);
  });

  it('waits for the interruption boundary before requesting an answer', async () => {
    let resolveInterruption!: () => void;
    const interruption = new Promise<void>((resolve) => {
      resolveInterruption = resolve;
    });
    const setupState = setup({ interruptNode: async () => interruption });
    await setupState.session.connect();
    const fake = mocks.FakeSession.instances[0];

    fake.emit('transport_event', { type: 'input_audio_buffer.speech_started' });
    const answer = setupState.session.ask('Explain this');
    await flushRealtime();
    expect(fake.transport.events).toEqual([]);
    resolveInterruption();
    await flushRealtime();
    expect(setupState.resumed).toEqual([]);

    finishResponse(fake, startResponse(fake));
    await answer;
    expect(setupState.resumed).toEqual(['node:scene-1']);
  });

  it('deduplicates repeated audio_stopped events for one answer generation', async () => {
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const resumeNode = vi.fn(async () => resumeGate);
    const setupState = setup({ resumeNode });
    await setupState.session.connect();
    const fake = mocks.FakeSession.instances[0];

    fake.emit('transport_event', { type: 'input_audio_buffer.speech_started' });
    const answer = await startAnswer(setupState.session, fake);
    finishResponse(fake, answer.id);
    finishResponse(fake, answer.id);
    await flushRealtime();

    expect(resumeNode).toHaveBeenCalledTimes(1);
    releaseResume();
    await flushRealtime();
    expect(setupState.events).toContainEqual({ type: 'node_resumed', nodeId: 'node:scene-1' });
  });

  it('re-interrupts when a newer answer starts while the previous resume is in flight', async () => {
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const interruptNode = vi.fn(async () => undefined);
    const resumeNode = vi.fn(async () => resumeGate);
    const setupState = setup({ interruptNode, resumeNode });
    await setupState.session.connect();
    const fake = mocks.FakeSession.instances[0];

    fake.emit('transport_event', { type: 'input_audio_buffer.speech_started' });
    const firstAnswer = await startAnswer(setupState.session, fake);
    finishResponse(fake, firstAnswer.id);
    await flushRealtime();
    expect(resumeNode).toHaveBeenCalledTimes(1);

    // A second response begins before the first response has finished
    // releasing local playback. The first completion must not clear the held
    // node or emit node_resumed for the newer response.
    const secondAnswer = await startAnswer(setupState.session, fake);
    releaseResume();
    await flushRealtime();
    expect(setupState.events).not.toContainEqual({
      type: 'node_resumed',
      nodeId: 'node:scene-1',
    });
    expect(interruptNode).toHaveBeenCalledTimes(2);

    finishResponse(fake, secondAnswer.id);
    await flushRealtime();
    expect(resumeNode).toHaveBeenCalledTimes(2);
  });

  it('does not surface a stale resume error after a newer answer starts', async () => {
    let rejectFirstResume!: (cause: Error) => void;
    const firstResume = new Promise<void>((_resolve, reject) => {
      rejectFirstResume = reject;
    });
    let resumeAttempts = 0;
    const resumeNode = vi.fn(async (nodeId: string) => {
      resumeAttempts += 1;
      if (resumeAttempts === 1) {
        await firstResume;
        return;
      }
      setupState.resumed.push(nodeId);
    });
    const setupState = setup({ resumeNode });
    await setupState.session.connect();
    const fake = mocks.FakeSession.instances[0];

    fake.emit('transport_event', { type: 'input_audio_buffer.speech_started' });
    const firstAnswer = await startAnswer(setupState.session, fake);
    finishResponse(fake, firstAnswer.id);
    await flushRealtime();
    expect(resumeNode).toHaveBeenCalledTimes(1);

    // A second response supersedes the first resume while it is awaiting the
    // local/W boundary. Its eventual rejection must not overwrite the newer
    // answer's UI error state.
    const secondAnswer = await startAnswer(setupState.session, fake);
    rejectFirstResume(new Error('stale resume failed'));
    await flushRealtime();
    expect(setupState.events).not.toContainEqual(
      expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ message: 'stale resume failed' }),
      }),
    );

    finishResponse(fake, secondAnswer.id);
    await flushRealtime();
    expect(setupState.resumed).toEqual(['node:scene-1']);
  });

  it('keeps the resume point when the controller resume command fails', async () => {
    const setupState = setup();
    let resumeAttempts = 0;
    setupState.session = new LiveCourseRealtimeSession({
      courseId: 'course-1',
      lessonId: 'lesson-1',
      learnerId: 'learner-1',
      audioBridge: setupState.bridge as never,
      getLocation: () => ({ nodeId: 'node:scene-1', sceneId: 'scene-1' }),
      getTeachingContext: () => 'Scene context',
      dispatchCommand: async (command) => {
        setupState.commands.push(command);
      },
      interruptNode: async () => undefined,
      resumeNode: async (nodeId) => {
        resumeAttempts += 1;
        if (resumeAttempts === 1) throw new Error('resume write failed');
        setupState.resumed.push(nodeId);
      },
      onEvent: (event) => setupState.events.push(event),
      fetchImpl: setupState.fetchImpl,
    });
    await setupState.session.connect();
    const fake = mocks.FakeSession.instances[0];

    fake.emit('transport_event', { type: 'input_audio_buffer.speech_started' });
    const firstAnswer = await startAnswer(setupState.session, fake);
    finishResponse(fake, firstAnswer.id);
    await flushRealtime();
    expect(setupState.resumed).toEqual([]);

    // A later response can retry the same frozen node; clearing it before the
    // failed write would make this second cycle a no-op.
    const secondAnswer = await startAnswer(setupState.session, fake);
    finishResponse(fake, secondAnswer.id);
    await flushRealtime();
    expect(setupState.resumed).toEqual(['node:scene-1']);
  });

  it('does not replay a completed resume when close begins while it is pending', async () => {
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const resumeNode = vi.fn(async () => resumeGate);
    const setupState = setup({ resumeNode });
    await setupState.session.connect();
    const fake = mocks.FakeSession.instances[0];

    fake.emit('transport_event', { type: 'input_audio_buffer.speech_started' });
    const answer = await startAnswer(setupState.session, fake);
    finishResponse(fake, answer.id);
    await flushRealtime();
    expect(resumeNode).toHaveBeenCalledTimes(1);

    const closePromise = setupState.session.close();
    releaseResume();
    await expect(closePromise).resolves.toBeUndefined();

    expect(resumeNode).toHaveBeenCalledTimes(1);
    expect(fake.closed).toBe(true);
    expect(setupState.bridge.closed).toBe(1);
  });

  it('does not attach a transport that finishes connecting after close', async () => {
    let releaseSecret!: (value: Response) => void;
    const secretGate = new Promise<Response>((resolve) => {
      releaseSecret = resolve;
    });
    const setupState = setup();
    setupState.fetchImpl.mockImplementationOnce(async () => secretGate);

    const connectPromise = setupState.session.connect();
    await flushRealtime();
    const closePromise = setupState.session.close();
    await expect(closePromise).resolves.toBeUndefined();

    releaseSecret(
      response({
        value: 'ek_test',
        expiresAt: 1_900_000_000,
        model: 'gpt-realtime-2.1',
        voice: 'marin',
      }),
    );
    await expect(connectPromise).rejects.toBeInstanceOf(RealtimeSessionClosingError);
    await flushRealtime();

    expect(setupState.session.connected).toBe(false);
    expect(setupState.bridge.closed).toBe(1);
    expect(setupState.events).not.toContainEqual({ type: 'status', status: 'connected' });
  });

  it('closes a transport whose handshake is still pending when close starts', async () => {
    let releaseHandshake!: () => void;
    const handshakeGate = new Promise<void>((resolve) => {
      releaseHandshake = resolve;
    });
    vi.spyOn(mocks.FakeSession.prototype, 'connect').mockImplementation(async () => {
      await handshakeGate;
    });

    const setupState = setup();
    const connectPromise = setupState.session.connect();
    await flushRealtime();
    const fake = mocks.FakeSession.instances[0];
    if (!fake) throw new Error('pending realtime session was not created');

    const closePromise = setupState.session.close();
    expect(fake.closed).toBe(true);
    releaseHandshake();

    await expect(connectPromise).rejects.toBeInstanceOf(RealtimeSessionClosingError);
    await expect(closePromise).resolves.toBeUndefined();
    expect(fake.closed).toBe(true);
    expect(setupState.session.connected).toBe(false);
  });

  it('closes a transport after a failed handshake and permits a clean retry', async () => {
    const handshakeError = new Error('handshake failed');
    vi.spyOn(mocks.FakeSession.prototype, 'connect')
      .mockRejectedValueOnce(handshakeError)
      .mockResolvedValueOnce(undefined);

    const setupState = setup();
    await expect(setupState.session.connect()).rejects.toBe(handshakeError);

    const first = mocks.FakeSession.instances[0];
    if (!first) throw new Error('failed realtime session was not created');
    expect(first.closed).toBe(true);
    expect(setupState.session.connected).toBe(false);

    await expect(setupState.session.connect()).resolves.toBeUndefined();
    const second = mocks.FakeSession.instances[1];
    expect(second).toBeDefined();
    expect(second?.closed).toBe(false);
    expect(setupState.session.connected).toBe(true);
  });

  it('does not let a stale handshake close a newer connection attempt', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let handshakeIndex = 0;
    vi.spyOn(mocks.FakeSession.prototype, 'connect').mockImplementation(async () => {
      const gate = handshakeIndex++ === 0 ? firstGate : secondGate;
      await gate;
    });

    const setupState = setup();
    const firstConnect = setupState.session.connect();
    await flushRealtime();
    const first = mocks.FakeSession.instances[0];
    if (!first) throw new Error('first pending realtime session was not created');

    await setupState.session.close();
    const secondConnect = setupState.session.connect();
    await flushRealtime();
    const second = mocks.FakeSession.instances[1];
    if (!second) throw new Error('second pending realtime session was not created');

    releaseFirst();
    await expect(firstConnect).rejects.toBeInstanceOf(RealtimeSessionClosingError);
    expect(second.closed).toBe(false);

    releaseSecond();
    await expect(secondConnect).resolves.toBeUndefined();
    expect(setupState.session.connected).toBe(true);
    expect(second.closed).toBe(false);
  });

  it('keeps a replacement connection alive when an old secret request resolves late', async () => {
    let releaseFirstSecret!: (value: Response) => void;
    const firstSecret = new Promise<Response>((resolve) => {
      releaseFirstSecret = resolve;
    });
    const setupState = setup();
    let secretRequests = 0;
    setupState.fetchImpl.mockImplementation(async (input) => {
      if (!String(input).endsWith('/client-secret')) return response({});
      secretRequests += 1;
      if (secretRequests === 1) return firstSecret;
      return response({
        value: 'ek_test',
        expiresAt: 1_900_000_000,
        model: 'gpt-realtime-2.1',
        voice: 'marin',
      });
    });

    const firstConnect = setupState.session.connect();
    await flushRealtime();
    await setupState.session.close();
    const secondConnect = setupState.session.connect();
    await expect(secondConnect).resolves.toBeUndefined();

    releaseFirstSecret(
      response({
        value: 'ek_test',
        expiresAt: 1_900_000_000,
        model: 'gpt-realtime-2.1',
        voice: 'marin',
      }),
    );
    await expect(firstConnect).rejects.toBeInstanceOf(RealtimeSessionClosingError);
    expect(setupState.session.connected).toBe(true);
    expect(mocks.FakeSession.instances).toHaveLength(1);
  });

  it('ends avatar speech when a speaking session is closed', async () => {
    const setupState = setup();
    await setupState.session.connect();
    const fake = mocks.FakeSession.instances[0];

    const speech = setupState.session.speak('Original lesson');
    void speech.catch(() => undefined);
    startResponse(fake);
    await setupState.session.close();

    expect(setupState.events).toContainEqual({ type: 'audio_interrupted' });
    expect(setupState.events.at(-1)).toEqual({ type: 'status', status: 'closed' });
  });

  it('releases a held interruption before closing the realtime transport', async () => {
    const setupState = setup();
    await setupState.session.connect();
    const fake = mocks.FakeSession.instances[0];

    fake.emit('transport_event', { type: 'input_audio_buffer.speech_started' });
    await setupState.session.close();

    expect(setupState.resumed).toEqual(['node:scene-1']);
    expect(fake.closed).toBe(true);
    expect(setupState.bridge.closed).toBe(1);
  });

  it('allows an explicitly reused session to reconnect after a successful close', async () => {
    const setupState = setup();
    await setupState.session.connect();
    const first = mocks.FakeSession.instances[0];
    if (!first) throw new Error('first realtime session was not created');

    await setupState.session.close();
    await setupState.session.connect();

    const second = mocks.FakeSession.instances[1];
    expect(second).toBeDefined();
    expect(first.closed).toBe(true);
    expect(setupState.bridge.activated).toBe(2);
    expect(setupState.events).toContainEqual({ type: 'status', status: 'connected' });
  });

  it('ignores events emitted by a transport from an earlier connection', async () => {
    const setupState = setup();
    await setupState.session.connect();
    const first = mocks.FakeSession.instances[0];
    if (!first) throw new Error('first realtime session was not created');
    await setupState.session.close();
    await setupState.session.connect();
    const second = mocks.FakeSession.instances[1];
    if (!second) throw new Error('second realtime session was not created');

    const eventCountBefore = setupState.events.length;
    first.emit('audio_start');
    first.emit('transport_event', { type: 'input_audio_buffer.speech_started' });
    first.emit('audio_stopped');

    expect(setupState.events).toHaveLength(eventCountBefore);
    expect(second.interruptCount).toBe(0);
  });

  it('keeps the transport and resume point open when interruption release fails on close', async () => {
    let resumeAttempts = 0;
    const released: string[] = [];
    const setupState = setup({
      resumeNode: async (nodeId) => {
        resumeAttempts += 1;
        if (resumeAttempts === 1) throw new Error('release failed');
        released.push(nodeId);
      },
    });
    await setupState.session.connect();
    const fake = mocks.FakeSession.instances[0];

    fake.emit('transport_event', { type: 'input_audio_buffer.speech_started' });
    await expect(setupState.session.close()).rejects.toThrow('release failed');

    expect(fake.closed).toBe(false);
    expect(setupState.bridge.closed).toBe(0);
    await expect(setupState.session.close()).resolves.toBeUndefined();
    expect(released).toEqual(['node:scene-1']);
    expect(fake.closed).toBe(true);
  });

  it('keeps close retryable when the SDK session close itself throws', async () => {
    const closeError = new Error('transport close failed');
    const close = vi.spyOn(mocks.FakeSession.prototype, 'close').mockImplementationOnce(() => {
      throw closeError;
    });
    const setupState = setup();
    await setupState.session.connect();
    const fake = mocks.FakeSession.instances[0];
    if (!fake) throw new Error('realtime session was not created');

    await expect(setupState.session.close()).rejects.toBe(closeError);
    expect(setupState.session.connected).toBe(true);

    await expect(setupState.session.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
    expect(fake.closed).toBe(true);
    expect(setupState.session.connected).toBe(false);
  });

  it('surfaces a typed upstream failure instead of hiding it', async () => {
    const setupState = setup();
    setupState.fetchImpl.mockImplementationOnce(async () =>
      response({ error: { code: 'REALTIME_NOT_CONFIGURED', message: 'missing' } }, 503),
    );

    await expect(setupState.session.connect()).rejects.toBeInstanceOf(RealtimeHttpError);
    expect(setupState.events).toContainEqual({ type: 'status', status: 'unconfigured' });
  });

  // J3.1/J3.2 实时字幕（docs/spec/02-product-manual.md 课堂）：transport 文本
  // 增量投影为只读 transcript 事件；不进动作总线、不持久化、不产生证据。
  describe('live captions', () => {
    it('projects scripted narration as a teacher caption and ignores shrinking transcript prefixes', async () => {
      const state = setup();
      await state.session.connect();
      const fake = mocks.FakeSession.instances[0];
      const speech = state.session.speak('向量告诉我们方向。');
      expect(state.events).toContainEqual({
        type: 'transcript',
        speaker: 'teacher',
        text: '向量告诉我们方向。',
      });
      const id = startResponse(fake);
      fake.emit('transport_event', {
        type: 'response.output_audio_transcript.delta',
        response_id: id,
        delta: '向',
      });
      const teacherCaptions = state.events.filter(
        (event) => event.type === 'transcript' && event.speaker === 'teacher',
      );
      expect(teacherCaptions.at(-1)).toEqual({
        type: 'transcript',
        speaker: 'teacher',
        text: '向量告诉我们方向。',
      });
      finishResponse(fake, id);
      await speech;
    });

    it.each(['response.output_audio_transcript', 'response.audio_transcript'])(
      'projects %s deltas as captions for audio-only responses',
      async (prefix) => {
        const state = setup();
        await state.session.connect();
        const fake = mocks.FakeSession.instances[0];
        fake.emit('transport_event', {
          type: `${prefix}.delta`,
          response_id: 'speech',
          delta: 'Hello ',
        });
        fake.emit('transport_event', {
          type: `${prefix}.delta`,
          response_id: 'speech',
          delta: 'learner',
        });
        expect(state.events.at(-1)).toEqual({
          type: 'transcript',
          speaker: 'teacher',
          text: 'Hello learner',
        });
        fake.emit('transport_event', {
          type: `${prefix}.done`,
          response_id: 'speech',
          transcript: 'Hello learner.',
        });
        expect(state.events.at(-1)).toEqual({
          type: 'transcript',
          speaker: 'teacher',
          text: 'Hello learner.',
        });
        expect(state.resumed).toEqual([]);
      },
    );
    it('requests audio output with transcription rather than mutually exclusive audio and text', async () => {
      const setupState = setup();
      await setupState.session.connect();
      const fake = mocks.FakeSession.instances[0];

      expect(fake.options).toEqual(
        expect.objectContaining({
          config: expect.objectContaining({ outputModalities: ['audio'] }),
        }),
      );
    });

    it('accumulates teacher text deltas per response and emits the final text on done', async () => {
      const setupState = setup();
      await setupState.session.connect();
      const fake = mocks.FakeSession.instances[0];

      fake.emit('transport_event', {
        type: 'response.output_text.delta',
        response_id: 'resp-1',
        delta: '今天我们讲',
      });
      fake.emit('transport_event', {
        type: 'response.output_text.delta',
        response_id: 'resp-1',
        delta: '极限的定义。',
      });

      expect(setupState.events).toContainEqual({
        type: 'transcript',
        speaker: 'teacher',
        text: '今天我们讲',
      });
      expect(setupState.events).toContainEqual({
        type: 'transcript',
        speaker: 'teacher',
        text: '今天我们讲极限的定义。',
      });

      fake.emit('transport_event', {
        type: 'response.output_text.done',
        response_id: 'resp-1',
        text: '今天我们讲极限的定义。',
      });
      // A new response starts a fresh accumulation instead of appending.
      fake.emit('transport_event', {
        type: 'response.output_text.delta',
        response_id: 'resp-2',
        delta: '先看一个例子',
      });

      const transcripts = setupState.events.filter((event) => event.type === 'transcript');
      expect(transcripts.at(-1)).toEqual({
        type: 'transcript',
        speaker: 'teacher',
        text: '先看一个例子',
      });
    });

    it('accumulates learner transcription per item and prefers the completed text', async () => {
      const setupState = setup();
      await setupState.session.connect();
      const fake = mocks.FakeSession.instances[0];

      fake.emit('transport_event', {
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'item-1',
        delta: '为什么',
      });
      fake.emit('transport_event', {
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'item-1',
        delta: '是连续的',
      });
      fake.emit('transport_event', {
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item-1',
        transcript: '为什么是连续的',
      });

      expect(setupState.events).toContainEqual({
        type: 'transcript',
        speaker: 'student',
        text: '为什么是连续的',
      });
      const transcripts = setupState.events.filter((event) => event.type === 'transcript');
      expect(transcripts.at(-1)).toEqual({
        type: 'transcript',
        speaker: 'student',
        text: '为什么是连续的',
      });
    });

    it('ignores caption events after the session closes', async () => {
      const setupState = setup();
      await setupState.session.connect();
      const fake = mocks.FakeSession.instances[0];

      await setupState.session.close();
      fake.emit('transport_event', {
        type: 'response.output_text.delta',
        response_id: 'resp-late',
        delta: '迟到的文本',
      });

      expect(setupState.events).not.toContainEqual(expect.objectContaining({ type: 'transcript' }));
    });
  });
});

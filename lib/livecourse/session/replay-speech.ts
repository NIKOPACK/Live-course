import { LiveCourseRealtimeSession } from '@/lib/livecourse/realtime/client/session';
import { RealtimeAudioBridge } from '@/lib/livecourse/realtime/client/audio-bridge';
import type { TeacherSpeechPort } from '@/lib/livecourse/realtime/client/teacher-speech';
import { VolcTeacherSpeechSession } from '@/lib/livecourse/realtime/client/volc-teacher-speech';

export interface ReplaySpeechOptions {
  provider: 'openai' | 'volc';
  courseId: string;
  lessonId: string;
  getLearnerId: () => Promise<string>;
  getApiKey: () => string | undefined;
  getInstructions: () => string;
}

/** J4: receive-only authored narration, without classroom tools or memory writers. */
export function createReplaySpeech(options: ReplaySpeechOptions): TeacherSpeechPort {
  let disposed = false;
  let connecting: Promise<void> | undefined;
  let session: LiveCourseRealtimeSession | VolcTeacherSpeechSession | undefined;
  let audioBridge: RealtimeAudioBridge | undefined;
  const assertActive = () => {
    if (disposed) throw new DOMException('Replay speech closed', 'AbortError');
  };
  const rejectInteraction = async () => {
    throw new Error('Learner interaction is unavailable in replay');
  };
  const connect = async () => {
    assertActive();
    if (connecting) return connecting;
    connecting = (async () => {
      if (!session) {
        if (options.provider === 'volc') {
          session = new VolcTeacherSpeechSession({
            readOnly: true,
            getInstructions: options.getInstructions,
          });
        } else {
          const learnerId = await options.getLearnerId();
          assertActive();
          audioBridge = new RealtimeAudioBridge(document.createElement('audio'));
          session = new LiveCourseRealtimeSession({
            courseId: options.courseId,
            lessonId: options.lessonId,
            learnerId,
            readOnly: true,
            audioBridge,
            getClientSecretApiKey: options.getApiKey,
            getLocation: () => null,
            getTeachingContext: options.getInstructions,
            dispatchCommand: rejectInteraction,
            interruptNode: rejectInteraction,
            resumeNode: rejectInteraction,
            canInterrupt: () => false,
          });
        }
      }
      await session.connect();
      assertActive();
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  };
  return {
    connect,
    ask: rejectInteraction,
    async speak(text, { signal } = {}) {
      signal?.throwIfAborted();
      await connect();
      signal?.throwIfAborted();
      assertActive();
      await session!.speak(text, { signal });
      signal?.throwIfAborted();
      assertActive();
    },
    async close() {
      disposed = true;
      await session?.close();
      await connecting?.catch(() => {});
      await session?.close();
      await audioBridge?.close();
    },
  };
}

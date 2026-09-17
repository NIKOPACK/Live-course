import type { SpeechAction } from '@/lib/types/action';

/**
 * Playback Types - Types for lecture playback and live discussion engine
 */

export interface PlaybackSnapshot {
  sceneIndex: number;
  actionIndex: number;
  consumedDiscussions: string[];
  sceneId?: string;
}

export interface PlaybackSpeechContext {
  sceneId: string;
  lastCompletedText: string | null;
  resumeText: string | null;
  nextText: string | null;
}

export interface TeachingPlaybackPosition {
  sceneId: string;
  actionId: string | null;
  actionIndex: number;
  speechChunkIndex: number;
}

/** Visual effects (for onEffectFire callback) */
export type Effect =
  | { kind: 'spotlight'; targetId: string; dimOpacity?: number }
  | { kind: 'laser'; targetId: string; color?: string };

/** Engine mode state machine */
export type EngineMode = 'idle' | 'playing' | 'paused' | 'live';

/** Discussion topic state */
export type TopicState = 'active' | 'pending' | 'closed';

/** Trigger event (for proactive discussion card) */
export interface TriggerEvent {
  id: string;
  question: string;
  prompt?: string;
  agentId?: string;
}

/** Playback engine callbacks */
export interface PlaybackEngineCallbacks {
  onModeChange?: (mode: EngineMode) => void;
  onSceneChange?: (sceneId: string) => void;
  onSpeechStart?: (text: string) => void;
  onSpeechEnd?: () => void;
  speak?: (text: string, signal: AbortSignal) => Promise<void>;
  onTeachingPosition?: (position: TeachingPlaybackPosition) => Promise<void>;
  question?: (
    question: NonNullable<SpeechAction['oralQuestion']>,
    signal: AbortSignal,
  ) => Promise<void>;
  /**
   * Classroom teaching / replay: consume leftover `discussion` actions without
   * the roundtable classmate protocol. Editor playback omits this and keeps
   * the proactive-card path. docs/spec/04-detailed-design.md §1.
   */
  skipRoundtableDiscussion?: boolean;
  onSpeechCancel?: () => void;
  onError?: (error: Error) => void;
  onTextDelta?: (content: string) => void;
  onSpeakerChange?: (role: string) => void;
  onEffectFire?: (effect: Effect) => void;

  // Proactive discussion
  onProactiveShow?: (trigger: TriggerEvent) => void;
  onProactiveHide?: () => void;

  // Discussion lifecycle
  onDiscussionConfirmed?: (topic: string, prompt?: string, agentId?: string) => void;
  onDiscussionEnd?: () => void;
  onUserInterrupt?: (text: string) => void;

  // Topic / Transcript
  onTopicStart?: (type: 'lecture' | 'discussion', title: string) => void;
  onTopicAppend?: (role: string, text: string) => void;
  onTopicEnd?: () => void;

  // Progress tracking (for persistence)
  onProgress?: (snapshot: PlaybackSnapshot) => void;

  /** Check if a given agent is in the user's selected list (for skipping discussion actions) */
  isAgentSelected?: (agentId: string) => boolean;

  /** Get current playback speed multiplier (e.g. 1, 1.5, 2) */
  getPlaybackSpeed?: () => number;

  onComplete?: () => void;
}

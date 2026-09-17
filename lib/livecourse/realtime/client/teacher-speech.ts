import type { OralQuestion } from '@/lib/livecourse/domain/schemas';
import type { OralQuestionOptions } from './oral-question';

export interface TeacherSpeechPort {
  connect(): Promise<void>;
  speak(text: string, options?: { signal?: AbortSignal }): Promise<void>;
  ask(text: string): Promise<void>;
  question?(question: OralQuestion, options: OralQuestionOptions): Promise<void>;
}

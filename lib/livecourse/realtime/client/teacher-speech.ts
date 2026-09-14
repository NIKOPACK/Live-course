export interface TeacherSpeechPort {
  connect(): Promise<void>;
  speak(text: string, options?: { signal?: AbortSignal }): Promise<void>;
  ask(text: string): Promise<void>;
}

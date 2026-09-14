import {
  lessonCompletionEventSchema,
  teachingActionSchema,
  type LessonCompletionEvent,
  type TeachingAction,
} from '@/lib/livecourse/domain';

export type TeachingActionHandler = (action: TeachingAction) => void | Promise<void>;

class TeachingActionBus {
  private readonly handlers = new Set<TeachingActionHandler>();

  subscribe(handler: TeachingActionHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async publish(input: TeachingAction): Promise<TeachingAction> {
    const action = teachingActionSchema.parse(input);
    await Promise.all([...this.handlers].map((handler) => handler(action)));
    return action;
  }
}

export const teachingActionBus = new TeachingActionBus();

export type LessonCompletionEventHandler = (event: LessonCompletionEvent) => void | Promise<void>;

/**
 * 权威 `lesson.complete_node` 事件总线（docs/spec/04-detailed-design.md §1，
 * A2）。完成事件不是 TeachingAction，走独立总线；只有课堂控制器在 speech /
 * action 均成功结束后才能提交，订阅方只能消费，不能伪造提交。
 */
class LessonCompletionEventBus {
  private readonly handlers = new Set<LessonCompletionEventHandler>();

  subscribe(handler: LessonCompletionEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async publish(input: LessonCompletionEvent): Promise<LessonCompletionEvent> {
    const event = lessonCompletionEventSchema.parse(input);
    await Promise.all([...this.handlers].map((handler) => handler(event)));
    return event;
  }
}

export const lessonCompletionEventBus = new LessonCompletionEventBus();

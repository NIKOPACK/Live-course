import type { ConstrainedAssistantExecutor } from '@/lib/livecourse/realtime/assistant-task-runner';

/** Production fails explicitly until a real, capability-scoped executor is configured. */
export const unavailableAssistantExecutor: ConstrainedAssistantExecutor = {
  async execute() {
    throw new Error('assistant execution is not configured for this deployment');
  },
};

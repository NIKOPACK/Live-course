import {
  assistantTaskProposalSchema,
  type AssistantTask,
  type AssistantTaskProposal,
} from '@/lib/livecourse/domain';
import type {
  AssistantCapability,
  ConstrainedAssistantExecutor,
} from '@/lib/livecourse/realtime/assistant-task-runner';

function referenceValue(task: AssistantTask, prefix: string): string | null {
  const ref = task.inputRefs.find((candidate) => candidate.startsWith(prefix));
  return ref ? ref.slice(prefix.length) : null;
}

function requireReference(task: AssistantTask, prefix: string, label: string): string {
  const value = referenceValue(task, prefix);
  if (!value?.trim()) {
    throw new Error(`${label} input reference (${prefix}…) is required for this task`);
  }
  return value;
}

export const deterministicAssistantExecutor: ConstrainedAssistantExecutor = {
  async execute(
    task: AssistantTask,
    capability: AssistantCapability,
  ): Promise<AssistantTaskProposal> {
    switch (capability) {
      case 'read_source_reference': {
        const sourceId = requireReference(task, 'source:', 'source');
        return assistantTaskProposalSchema.parse({
          kind: 'summarize_source',
          summary: `Summarized reference ${sourceId} for node ${task.nodeId}.`,
          sourceId,
        });
      }
      case 'draft_classroom_note': {
        const content = referenceValue(task, 'note:') ?? referenceValue(task, 'feedback:');
        if (!content?.trim()) throw new Error('a note or feedback reference is required');
        return assistantTaskProposalSchema.parse({
          kind: task.kind === 'draft_feedback' ? 'draft_feedback' : 'draft_board_note',
          summary: 'Drafted a classroom note from the test reference.',
          content,
        });
      }
      case 'read_lesson_reference': {
        const targetNodeId = requireReference(task, 'node:', 'lesson node');
        return assistantTaskProposalSchema.parse({
          kind: 'suggest_next_step',
          summary: `Suggested moving to node ${targetNodeId}.`,
          targetNodeId,
        });
      }
    }
  },
};

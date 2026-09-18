import { describe, expect, it } from 'vitest';
import { stripShareMaterials } from '@/lib/livecourse/share/strip';
import { htmlLessonPlan, htmlScene, htmlStage } from './fixtures';

describe('stripShareMaterials', () => {
  it('drops C/W/evidence fields and keeps lesson design misconceptions', () => {
    const dirty = {
      stage: htmlStage(),
      scenes: [htmlScene('<p>ok</p>')],
      lessonPlan: htmlLessonPlan(),
      learnerId: 'anon:sharer',
      progress: { completedNodeIds: ['node-one'] },
      intake: { level: 'advanced' },
      misconceptions: ['a learning-instance mix-up'],
      evidence: [{ id: 'ev-1' }],
      playbackPosition: { nodeId: 'node-one' },
    };

    const cleaned = stripShareMaterials(dirty);
    expect(cleaned).not.toHaveProperty('learnerId');
    expect(cleaned).not.toHaveProperty('progress');
    expect(cleaned).not.toHaveProperty('intake');
    expect(cleaned).not.toHaveProperty('misconceptions');
    expect(cleaned).not.toHaveProperty('evidence');
    expect(cleaned).not.toHaveProperty('playbackPosition');
    expect(cleaned.lessonPlan.nodes[0]?.design?.misconceptions).toEqual([
      'Confusing frequency with amplitude',
    ]);
    expect((cleaned.stage as { id: string }).id).toBe('stage-AAA');
  });
});

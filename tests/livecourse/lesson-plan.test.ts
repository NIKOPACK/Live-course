import { describe, expect, it } from 'vitest';

import { deriveLessonPlanFromStage, goalIdForScene } from '@/lib/livecourse/domain';
import type { Scene, Stage } from '@/lib/types/stage';

describe('LiveCourse lesson plan projection', () => {
  it('projects LiveCourse scenes without changing the Stage/Scene DSL', () => {
    const stage = {
      id: 'stage-1',
      name: 'Algebra',
      createdAt: Date.parse('2026-08-10T08:00:00.000Z'),
      updatedAt: Date.parse('2026-08-10T08:00:00.000Z'),
    } as Stage;
    const scenes = [
      { id: 'slide-1', stageId: stage.id, title: 'Concept', type: 'slide', order: 0 },
      { id: 'quiz-1', stageId: stage.id, title: 'Check', type: 'quiz', order: 1 },
    ] as Scene[];

    const plan = deriveLessonPlanFromStage({ stage, scenes });

    expect(plan.stageId).toBe(stage.id);
    expect(plan.nodes.map((node) => node.sceneId)).toEqual(['slide-1', 'quiz-1']);
    expect(plan.goals).toHaveLength(1);
    expect(plan.goals[0].id).toBe(goalIdForScene('quiz-1'));
    expect(plan.nodes[1].goalIds).toEqual([goalIdForScene('quiz-1')]);
    expect(scenes[0]).not.toHaveProperty('goalIds');
  });
});

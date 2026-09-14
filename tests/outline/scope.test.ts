import { describe, expect, it } from 'vitest';

import { likelyNeedsKnowledgeMap } from '@/lib/livecourse/outline/scope';

describe('likelyNeedsKnowledgeMap', () => {
  it.each(['我想学高数', 'teach me physics', '学习 machine learning'])(
    'flags broad subject request: %s',
    (requirement) => {
      expect(likelyNeedsKnowledgeMap(requirement)).toBe(true);
    },
  );

  it.each(['教我链式法则', 'limits and continuity', '如何计算定积分'])(
    'does not flag an explicitly scoped request: %s',
    (requirement) => {
      expect(likelyNeedsKnowledgeMap(requirement)).toBe(false);
    },
  );

  it('does not flag an empty requirement', () => {
    expect(likelyNeedsKnowledgeMap('   ')).toBe(false);
  });
});

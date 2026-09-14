/**
 * Vendored from moeru-ai/airi (see SOURCE.md).
 * Upstream: packages/stage-ui-three/src/composables/vrm/expression.ts
 * Vue refs removed; emotion recipes, blending, easing and reset logic verbatim.
 */

export interface AiriEmotionExpression {
  name: string;
  value: number;
  duration?: number;
  curve?: (t: number) => number;
}

export interface AiriEmotionState {
  expression?: AiriEmotionExpression[];
  blendDuration?: number;
}

export interface AiriVrmEmoteManager {
  readonly expressionMap: Record<string, unknown>;
  getValue(name: string): number | null;
  setValue(name: string, value: number): void;
}

// Utility functions
const lerp = (start: number, end: number, t: number): number => {
  return start + (end - start) * t;
};

const easeInOutCubic = (t: number): number => {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};

const clampIntensity = (value: number): number => {
  return Math.min(1, Math.max(0, value));
};

// Emotion states definition — values are the "full weight" targets;
// actual applied weight is value × clamped intensity.
// Using slightly lower values (0.7–0.8) for primary expressions to
// prevent the "too raw / smiles too much" problem reported in airi #590.
export function createAiriEmotionStates(): Map<string, AiriEmotionState> {
  return new Map<string, AiriEmotionState>([
    [
      'happy',
      {
        expression: [
          { name: 'happy', value: 0.7, duration: 0.3 },
          { name: 'aa', value: 0.2 },
        ],
        blendDuration: 0.4,
      },
    ],
    [
      'sad',
      {
        expression: [
          { name: 'sad', value: 0.7 },
          { name: 'oh', value: 0.15 },
        ],
        blendDuration: 0.4,
      },
    ],
    [
      'angry',
      {
        expression: [
          { name: 'angry', value: 0.7 },
          { name: 'ee', value: 0.3 },
        ],
        blendDuration: 0.3,
      },
    ],
    [
      'surprised',
      {
        expression: [
          { name: 'surprised', value: 0.8 },
          { name: 'oh', value: 0.4 },
        ],
        blendDuration: 0.15,
      },
    ],
    [
      'neutral',
      {
        expression: [{ name: 'neutral', value: 1.0 }],
        blendDuration: 0.6,
      },
    ],
    [
      'think',
      {
        expression: [{ name: 'think', value: 0.7 }],
        blendDuration: 0.5,
      },
    ],
    [
      'relaxed',
      {
        expression: [{ name: 'relaxed', value: 0.7 }],
        blendDuration: 0.4,
      },
    ],
  ]);
}

export class AiriVrmEmote {
  #vrm: { expressionManager?: AiriVrmEmoteManager | null };

  #emotionStates = createAiriEmotionStates();
  #currentEmotion: string | null = null;
  #isTransitioning = false;
  #transitionProgress = 0;
  #currentExpressionValues = new Map<string, number>();
  #targetExpressionValues = new Map<string, number>();
  #resetTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor(vrm: { expressionManager?: AiriVrmEmoteManager | null }) {
    this.#vrm = vrm;
  }

  get currentEmotion(): string | null {
    return this.#currentEmotion;
  }

  get isTransitioning(): boolean {
    return this.#isTransitioning;
  }

  #clearResetTimeout = () => {
    if (this.#resetTimeout) {
      clearTimeout(this.#resetTimeout);
      this.#resetTimeout = undefined;
    }
  };

  setEmotion = (emotionName: string, intensity = 1) => {
    this.#clearResetTimeout();

    if (!this.#emotionStates.has(emotionName)) {
      console.warn(`Emotion ${emotionName} not found`);
      return;
    }

    const emotionState = this.#emotionStates.get(emotionName)!;
    this.#currentEmotion = emotionName;
    this.#isTransitioning = true;
    this.#transitionProgress = 0;

    // Store current expression values as starting point BEFORE resetting,
    // so the lerp transition starts from the actual displayed values
    // instead of snapping to 0 first (fixes airi #590).
    this.#currentExpressionValues.clear();
    this.#targetExpressionValues.clear();

    const normalizedIntensity = clampIntensity(intensity);

    const manager = this.#vrm.expressionManager;
    if (manager) {
      // Capture current values for all expressions we'll be transitioning
      const expressionNames = Object.keys(manager.expressionMap);
      for (const name of expressionNames) {
        const currentValue = manager.getValue(name) || 0;
        this.#currentExpressionValues.set(name, currentValue);
        // Default target is 0 for expressions not in the target emotion
        this.#targetExpressionValues.set(name, 0);
      }

      // Override target values for specified expressions in the emotion state
      for (const expr of emotionState.expression || []) {
        let actualName = expr.name;
        const modelNames = Object.keys(manager.expressionMap);
        const match = modelNames.find((n) => n.toLowerCase() === expr.name.toLowerCase());
        if (match) {
          actualName = match;
        }
        this.#targetExpressionValues.set(actualName, expr.value * normalizedIntensity);
      }
    }
  };

  setEmotionWithResetAfter = (emotionName: string, ms: number, intensity = 1) => {
    this.#clearResetTimeout();
    this.setEmotion(emotionName, intensity);

    // Set timeout to reset to neutral
    this.#resetTimeout = setTimeout(() => {
      this.setEmotion('neutral');
      this.#resetTimeout = undefined;
    }, ms);
  };

  update = (deltaTime: number) => {
    if (!this.#isTransitioning || !this.#currentEmotion) return;

    const emotionState = this.#emotionStates.get(this.#currentEmotion)!;
    const blendDuration = emotionState.blendDuration || 0.3;

    this.#transitionProgress += deltaTime / blendDuration;
    if (this.#transitionProgress >= 1.0) {
      this.#transitionProgress = 1.0;
      this.#isTransitioning = false;
    }

    // Update all expressions
    for (const [exprName, targetValue] of this.#targetExpressionValues) {
      const startValue = this.#currentExpressionValues.get(exprName) || 0;
      const currentValue = lerp(startValue, targetValue, easeInOutCubic(this.#transitionProgress));
      this.#vrm.expressionManager?.setValue(exprName, currentValue);
    }
  };

  addEmotionState = (emotionName: string, state: AiriEmotionState) => {
    this.#emotionStates.set(emotionName, state);
  };

  removeEmotionState = (emotionName: string) => {
    this.#emotionStates.delete(emotionName);
  };

  dispose = () => {
    this.#clearResetTimeout();
  };
}

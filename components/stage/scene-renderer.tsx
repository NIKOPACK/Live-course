'use client';

import { useMemo } from 'react';
import type { Scene, StageMode } from '@/lib/types/stage';
import { SlideEditor as SlideRenderer } from '../slide-renderer/Editor';
import { QuizView } from '../scene-renderers/quiz-view';
import { InteractiveRenderer } from '../scene-renderers/interactive-renderer';
import { PBLRenderer } from '../scene-renderers/pbl-renderer';
import type { StageStore } from '@/lib/api/stage-api-types';

interface SceneRendererProps {
  readonly scene: Scene;
  readonly mode: StageMode;
  /** Route scene-local interaction through an in-memory presentation surface. */
  readonly presentationOnly?: boolean;
  /** Optional presentation store used by PBL runtime adapters. */
  readonly presentationStore?: StageStore;
}

/**
 * Playback scene dispatcher. In Pro (edit) mode, Stage renders EditShell
 * directly as a top-level takeover — SceneRenderer is only on the playback
 * path, so it does not branch on `mode === 'edit'`.
 */
export function SceneRenderer({
  scene,
  mode,
  presentationOnly = false,
  presentationStore,
}: SceneRendererProps) {
  const renderer = useMemo(() => {
    switch (scene.type) {
      case 'slide':
        if (scene.content.type !== 'slide') return <div>Invalid slide content</div>;
        return <SlideRenderer mode={mode} presentationOnly={presentationOnly} />;
      case 'quiz':
        if (scene.content.type !== 'quiz') return <div>Invalid quiz content</div>;
        return (
          <QuizView
            key={scene.id}
            questions={scene.content.questions}
            html={scene.content.html}
            sceneId={scene.id}
            stageId={scene.stageId}
            presentationOnly={presentationOnly}
          />
        );
      case 'interactive':
        if (scene.content.type !== 'interactive') return <div>Invalid interactive content</div>;
        return (
          <InteractiveRenderer
            content={scene.content}
            sceneId={scene.id}
            presentationOnly={presentationOnly}
          />
        );
      case 'pbl':
        if (scene.content.type !== 'pbl') return <div>Invalid PBL content</div>;
        return (
          <PBLRenderer
            content={scene.content}
            mode={mode}
            sceneId={scene.id}
            presentationOnly={presentationOnly}
            presentationStore={presentationStore}
          />
        );
      default:
        return <div>Unknown scene type</div>;
    }
  }, [scene, mode, presentationOnly, presentationStore]);

  return <div className="w-full h-full">{renderer}</div>;
}

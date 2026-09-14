'use client';

import Canvas from './Canvas';
import type { StageMode } from '@/lib/types/stage';
import { PlaybackScreenCanvas } from './ScreenCanvas';

interface SlideEditorProps {
  readonly mode: StageMode;
  /** Keep replay on the read-only playback surface even if mode is stale. */
  readonly presentationOnly?: boolean;
}

/**
 * Slide Editor - wraps Canvas with SceneProvider
 */
export function SlideEditor({ mode, presentationOnly = false }: SlideEditorProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-hidden">
        {mode === 'autonomous' && !presentationOnly ? (
          <Canvas />
        ) : (
          <PlaybackScreenCanvas presentationOnly={presentationOnly} />
        )}
      </div>
    </div>
  );
}

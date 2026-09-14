/**
 * Vendored from moeru-ai/airi (see SOURCE.md).
 * Upstream: packages/stage-ui-three/src/composables/eye-tracking.ts
 * Vue computed/toValue removed; projection math verbatim.
 */

import type { PerspectiveCamera, Raycaster } from 'three';

import { Vector2, Vector3 } from 'three';

export type AiriTrackingMode = 'camera' | 'mouse' | 'none';

export interface AiriEyeFocusContext {
  raycaster: Raycaster;
  camera: PerspectiveCamera;
  defaultLookAt: Vector3;
}

export interface AiriEyeFocusOptions {
  trackingMode: AiriTrackingMode;
  cameraPosition: Vector3;
  context: AiriEyeFocusContext;
  screenBoundingBox: { top: number; left: number; height: number; width: number };
  /** Cursor position in the same client coordinate space as the screen bounds. */
  source?: { x: number; y: number } | null;
}

/**
 * Maps cursor and camera tracking modes into a VRM world-space eye focus target.
 * Verbatim port of AIRI's `useVRMEyeFocusFor` computed value.
 */
export function resolveAiriEyeFocus(options: AiriEyeFocusOptions): Vector3 {
  if (options.trackingMode === 'camera') {
    const cameraPosition = options.cameraPosition;
    return new Vector3(cameraPosition.x, cameraPosition.y, cameraPosition.z);
  }

  const ctx = options.context;
  const trackingSource = options.source;
  if (options.trackingMode === 'none' || !trackingSource) return ctx.defaultLookAt;
  const screen = options.screenBoundingBox;
  if (options.trackingMode === 'mouse') {
    return castScreenToCam(
      ctx,
      new Vector2(
        ((trackingSource.x - screen.left) / screen.width) * 2 - 1,
        -((trackingSource.y - screen.top) / screen.height) * 2 + 1,
      ),
    );
  }
  return ctx.defaultLookAt;
}

function castScreenToCam(ctx: AiriEyeFocusContext, point: Vector2): Vector3 {
  ctx.raycaster.setFromCamera(point, ctx.camera);
  const nearPlaneDistance = ctx.camera.near;
  const direction = ctx.raycaster.ray.direction.clone().normalize().multiplyScalar(8);
  const pointOnNearPlane = ctx.raycaster.ray.origin
    .clone()
    .add(direction.multiplyScalar(nearPlaneDistance));
  return pointOnNearPlane;
}

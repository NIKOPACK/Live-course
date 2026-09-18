import type { VRM } from '@pixiv/three-vrm';
import type { AnimationClip } from 'three';

import {
  AmbientLight,
  AnimationMixer,
  Box3,
  DirectionalLight,
  Group,
  Object3D,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  VectorKeyframeTrack,
  WebGLRenderer,
} from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMUtils } from '@pixiv/three-vrm';
import {
  createVRMAnimationClip,
  VRMLookAtQuaternionProxy,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation';

import { AiriVrmEmote } from './vendor/airi/expression';
import { randomSaccadeInterval } from './vendor/airi/eye-motions';
import { resolveAiriEyeFocus, type AiriTrackingMode } from './vendor/airi/eye-tracking';
import {
  createVrmInteractionColliders,
  getVrmInteractionExpression,
  getVrmInteractionTargetFromObjectName,
  isClickLikePointerGesture,
  VRM_INTERACTION_COOLDOWN_MS,
  type VrmInteractionColliderSet,
} from './vendor/airi/interaction';
import { AiriVrmLipSync } from './vendor/airi/lip-sync';
import { createAiriVrmLoader } from './vendor/airi/loader';
import { SpeakingGestures } from './speaking-gestures';

export type AiriVrmAvatarStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unsupported';
export type AiriVrmLookAt = 'student' | 'slides' | 'whiteboard' | 'camera';

export interface AiriVrmStatusDetail {
  status: AiriVrmAvatarStatus;
  error?: string;
}

export function createAiriVrmStatusEvent(
  status: AiriVrmAvatarStatus,
  error?: string,
): CustomEvent<AiriVrmStatusDetail> {
  return new CustomEvent<AiriVrmStatusDetail>('airi-vrm-status', {
    detail: { status, ...(error ? { error } : {}) },
  });
}

export interface AiriVrmAvatarElementApi extends HTMLElement {
  modelSrc: string;
  idleAnimationSrc: string;
  readonly status: AiriVrmAvatarStatus;
  /** AIRI bone colliders: tap head/feet/arms to trigger emotion reactions. */
  interactionsEnabled: boolean;
  /** Where the teacher's eyes track: nothing, the camera, or the cursor. */
  trackingMode: AiriTrackingMode;
  setExpression(name: string, intensity?: number): void;
  setExpressionWithReset(name: string, resetAfterMs: number, intensity?: number): void;
  setLookAt(target: AiriVrmLookAt): void;
  connectAudio(audioNode: AudioNode | null): void;
  disconnectAudio(): void;
}

declare global {
  interface HTMLElementTagNameMap {
    'airi-vrm-avatar': AiriVrmAvatarElementApi;
  }
}

export interface AiriVrmExpressionManager {
  readonly expressionMap: Record<string, unknown>;
  getValue(name: string): number | null;
  setValue(name: string, value: number): void;
}

const MOUTH_EXPRESSIONS = ['aa', 'ee', 'ih', 'oh', 'ou'] as const;
const DEFAULT_LOOK_AT: Record<AiriVrmLookAt, Vector3> = {
  student: new Vector3(0, 1.45, 2.2),
  slides: new Vector3(-0.8, 1.35, 2.2),
  whiteboard: new Vector3(0.8, 1.35, 2.2),
  camera: new Vector3(0, 1.5, 2.8),
};

let sharedLoader: GLTFLoader | undefined;

function getLoader(): GLTFLoader {
  if (sharedLoader) return sharedLoader;
  sharedLoader = createAiriVrmLoader();
  return sharedLoader;
}

/** Resolve an expression case-insensitively, as AIRI does for uploaded models. */
export function resolveExpressionName(
  expressionMap: Record<string, unknown>,
  requested: string,
): string | null {
  const normalized = requested.trim().toLowerCase();
  if (!normalized) return null;
  return Object.keys(expressionMap).find((name) => name.toLowerCase() === normalized) ?? null;
}

export function lookAtPosition(target: AiriVrmLookAt): Vector3 {
  return DEFAULT_LOOK_AT[target].clone();
}

export function clearMouthExpressions(manager: AiriVrmExpressionManager | undefined): void {
  if (!manager) return;
  for (const expression of MOUTH_EXPRESSIONS) {
    const name = resolveExpressionName(manager.expressionMap, expression);
    if (name) manager.setValue(name, 0);
  }
}

/** Match AIRI's root-position correction so one VRMA works across different VRM rigs. */
export function reAnchorRootPositionTrack(clip: AnimationClip, vrm: Pick<VRM, 'humanoid'>): void {
  const hips = vrm.humanoid?.getNormalizedBoneNode('hips');
  if (!hips) return;

  hips.updateMatrixWorld(true);
  const defaultHipPosition = new Vector3();
  hips.getWorldPosition(defaultHipPosition);
  const hipsTrack = clip.tracks.find(
    (track) => track instanceof VectorKeyframeTrack && track.name === `${hips.name}.position`,
  );
  if (!(hipsTrack instanceof VectorKeyframeTrack) || hipsTrack.values.length < 3) return;

  const animationOffset = new Vector3(
    hipsTrack.values[0] - defaultHipPosition.x,
    hipsTrack.values[1] - defaultHipPosition.y,
    hipsTrack.values[2] - defaultHipPosition.z,
  );
  for (const track of clip.tracks) {
    if (!(track instanceof VectorKeyframeTrack) || !track.name.endsWith('.position')) continue;
    for (let index = 0; index < track.values.length; index += 3) {
      track.values[index] -= animationOffset.x;
      track.values[index + 1] -= animationOffset.y;
      track.values[index + 2] -= animationOffset.z;
    }
  }
}

class BlinkController {
  #elapsed = 0;
  #nextBlink = 2;
  #progress = 0;

  update(manager: AiriVrmExpressionManager | undefined, delta: number): void {
    if (!manager) return;

    const blinkName = resolveExpressionName(manager.expressionMap, 'blink');
    if (!blinkName) return;

    this.#elapsed += delta;
    if (this.#progress === 0 && this.#elapsed >= this.#nextBlink) {
      this.#progress = 0.0001;
    }

    if (this.#progress > 0) {
      this.#progress += delta / 0.2;
      manager.setValue(blinkName, Math.sin(Math.PI * this.#progress));
      if (this.#progress >= 1) {
        this.#progress = 0;
        this.#elapsed = 0;
        this.#nextBlink = 1 + Math.random() * 5;
        manager.setValue(blinkName, 0);
      }
    }
  }
}

class EyeSaccadeController {
  #current = new Vector3();
  #offset = new Vector3();
  #elapsed = 0;
  #nextSaccade = 0;
  #initialized = false;

  reset(base: Vector3): void {
    this.#current.copy(base);
    this.#offset.set(0, 0, 0);
    this.#elapsed = 0;
    this.#nextSaccade = 0;
    this.#initialized = true;
  }

  update(base: Vector3, delta: number): Vector3 {
    if (!this.#initialized) this.reset(base);
    this.#elapsed += delta;
    if (this.#elapsed >= this.#nextSaccade) {
      // AIRI: random fixation offsets on a ±0.25 grid with saccade intervals
      // drawn from the probability distribution in vendor/airi/eye-motions.ts.
      this.#offset.set((Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5, 0);
      this.#elapsed = 0;
      this.#nextSaccade = randomSaccadeInterval() / 1000;
    }

    const desiredX = base.x + this.#offset.x;
    const desiredY = base.y + this.#offset.y;
    const rate = 1 - Math.exp(-18 * delta);
    this.#current.x += (desiredX - this.#current.x) * rate;
    this.#current.y += (desiredY - this.#current.y) * rate;
    this.#current.z += (base.z - this.#current.z) * rate;
    return this.#current;
  }
}

// AIRI's pinned stage-ui-three package is a Vue workspace package. This element
// keeps a framework-neutral Three/VRM shell while running AIRI's own vendored
// runtime code (vendor/airi): wLipSync phoneme lip sync, emotion recipes,
// blink, and eye saccade behavior.
const HTMLElementBase = (
  typeof HTMLElement === 'undefined' ? class {} : HTMLElement
) as typeof HTMLElement;

export class AiriVrmAvatarElement extends HTMLElementBase implements AiriVrmAvatarElementApi {
  static observedAttributes = ['model-src', 'idle-animation-src'];

  #status: AiriVrmAvatarStatus = 'idle';
  #modelSrc = '';
  #idleAnimationSrc = '';
  #canvas: HTMLCanvasElement | null = null;
  #renderer: WebGLRenderer | null = null;
  #scene: Scene | null = null;
  #camera: PerspectiveCamera | null = null;
  #resizeObserver: ResizeObserver | null = null;
  #frameHandle: number | null = null;
  #lastFrameAt = 0;
  #time = 0;
  #loadRequest = 0;
  #vrm: VRM | null = null;
  #group: Group | null = null;
  #mixer: AnimationMixer | null = null;
  #expression: AiriVrmEmote | null = null;
  #blink = new BlinkController();
  #eyeSaccade = new EyeSaccadeController();
  #lipSync = new AiriVrmLipSync();
  #gestures: SpeakingGestures | null = null;
  #motionPreference: MediaQueryList | null = null;
  #lookAt: AiriVrmLookAt = 'student';
  #lookAtTarget = lookAtPosition('student');
  #baseGroupY = 0;
  #colliders: VrmInteractionColliderSet | null = null;
  #raycaster = new Raycaster();
  #interactionsEnabled = true;
  #trackingMode: AiriTrackingMode = 'none';
  #pointer: { x: number; y: number } | null = null;
  #pointerDownAt: { x: number; y: number } | null = null;
  #lastInteractionAt = new Map<string, number>();

  get status(): AiriVrmAvatarStatus {
    return this.#status;
  }

  get modelSrc(): string {
    return this.#modelSrc;
  }

  set modelSrc(value: string) {
    const next = value.trim();
    if (next === this.#modelSrc) return;
    this.#modelSrc = next;
    if (next) this.setAttribute('model-src', next);
    else this.removeAttribute('model-src');
  }

  get idleAnimationSrc(): string {
    return this.#idleAnimationSrc;
  }

  set idleAnimationSrc(value: string) {
    const next = value.trim();
    if (next === this.#idleAnimationSrc) return;
    this.#idleAnimationSrc = next;
    if (next) this.setAttribute('idle-animation-src', next);
    else this.removeAttribute('idle-animation-src');
  }

  connectedCallback(): void {
    this.#modelSrc = this.getAttribute('model-src')?.trim() ?? '';
    this.#idleAnimationSrc = this.getAttribute('idle-animation-src')?.trim() ?? '';
    this.#mount();
    if (this.#renderer && this.#modelSrc) void this.#loadModel(this.#modelSrc);
  }

  disconnectedCallback(): void {
    this.#unmount();
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    if (name === 'model-src') {
      this.#modelSrc = newValue?.trim() ?? '';
      if (!this.isConnected) return;
      if (this.#modelSrc) {
        void this.#loadModel(this.#modelSrc);
      } else {
        this.#loadRequest += 1;
        this.#disposeModel();
        this.#setStatus('idle');
      }
    }
    if (name === 'idle-animation-src') {
      this.#idleAnimationSrc = newValue?.trim() ?? '';
    }
  }

  setExpression(name: string, intensity = 1): void {
    this.#expression?.setEmotion(name, intensity);
  }

  setExpressionWithReset(name: string, resetAfterMs: number, intensity = 1): void {
    this.#expression?.setEmotionWithResetAfter(name, resetAfterMs, intensity);
  }

  get interactionsEnabled(): boolean {
    return this.#interactionsEnabled;
  }

  set interactionsEnabled(value: boolean) {
    this.#interactionsEnabled = value;
  }

  get trackingMode(): AiriTrackingMode {
    return this.#trackingMode;
  }

  set trackingMode(value: AiriTrackingMode) {
    if (value === this.#trackingMode) return;
    this.#trackingMode = value;
    this.#pointer = null;
    if (this.#vrm) {
      this.#eyeSaccade.reset(this.#gazeBase());
      this.#applyLookAt(0.016);
    }
  }

  setLookAt(target: AiriVrmLookAt): void {
    this.#lookAt = target;
    this.#lookAtTarget.copy(lookAtPosition(target));
    this.#eyeSaccade.reset(this.#gazeBase());
    this.#applyLookAt(0.016);
  }

  /** AIRI eye-tracking: the gaze base depends on the active tracking mode. */
  #gazeBase(): Vector3 {
    if (this.#trackingMode === 'camera' && this.#camera) {
      return this.#camera.position;
    }
    if (this.#trackingMode === 'mouse' && this.#pointer && this.#camera && this.#canvas) {
      const rect = this.#canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return resolveAiriEyeFocus({
          trackingMode: 'mouse',
          cameraPosition: this.#camera.position,
          context: {
            raycaster: this.#raycaster,
            camera: this.#camera,
            defaultLookAt: this.#lookAtTarget,
          },
          screenBoundingBox: {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          },
          source: this.#pointer,
        });
      }
    }
    return this.#lookAtTarget;
  }

  #onPointerDown = (event: PointerEvent): void => {
    this.#pointerDownAt = { x: event.clientX, y: event.clientY };
  };

  #onPointerMove = (event: PointerEvent): void => {
    if (this.#trackingMode !== 'mouse') return;
    this.#pointer = { x: event.clientX, y: event.clientY };
  };

  #onPointerUp = (event: PointerEvent): void => {
    const start = this.#pointerDownAt;
    this.#pointerDownAt = null;
    if (
      !this.#interactionsEnabled ||
      !start ||
      !isClickLikePointerGesture(start, { x: event.clientX, y: event.clientY })
    ) {
      return;
    }
    this.#triggerInteraction(event.clientX, event.clientY);
  };

  /** AIRI Stage.vue: raycast the bone colliders, map the region to an emotion. */
  #triggerInteraction(clientX: number, clientY: number): void {
    const colliders = this.#colliders;
    const camera = this.#camera;
    const canvas = this.#canvas;
    if (!colliders || colliders.colliders.length === 0 || !camera || !canvas) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const point = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.#raycaster.setFromCamera(point, camera);
    const hit = this.#raycaster.intersectObjects([...colliders.colliders], false)[0];
    const target = hit ? getVrmInteractionTargetFromObjectName(hit.object.name) : null;
    if (!target) return;

    const now = Date.now();
    const lastTriggeredAt = this.#lastInteractionAt.get(target) ?? 0;
    if (now - lastTriggeredAt < VRM_INTERACTION_COOLDOWN_MS) return;
    this.#lastInteractionAt.set(target, now);

    const expression = getVrmInteractionExpression(target);
    this.setExpressionWithReset(expression, 3000, 1);
    this.dispatchEvent(new CustomEvent('airi-vrm-interaction', { detail: { target, expression } }));
  }

  connectAudio(audioNode: AudioNode | null): void {
    if (!audioNode) {
      this.disconnectAudio();
      return;
    }
    void this.#lipSync.connect(audioNode).catch((error: unknown) => {
      console.warn('Teacher lip-sync and speaking gestures unavailable', error);
      this.dispatchEvent(
        new CustomEvent('airi-vrm-warning', {
          detail: { message: `Speech animation unavailable: ${String(error)}` },
        }),
      );
    });
  }

  disconnectAudio(): void {
    this.#lipSync.disconnect();
    clearMouthExpressions(this.#vrm?.expressionManager);
  }

  #onMotionPreferenceChange = (): void => {
    if (this.#motionPreference?.matches) this.#gestures?.reset();
  };

  #mount(): void {
    if (this.#renderer || typeof document === 'undefined') return;

    this.#canvas = document.createElement('canvas');
    this.#canvas.setAttribute('aria-label', '3D AI teacher');
    this.#canvas.style.display = 'block';
    this.#canvas.style.height = '100%';
    this.#canvas.style.width = '100%';
    this.replaceChildren(this.#canvas);

    try {
      this.#renderer = new WebGLRenderer({
        alpha: true,
        antialias: true,
        canvas: this.#canvas,
        powerPreference: 'high-performance',
      });
    } catch (error) {
      this.#setStatus('unsupported', error instanceof Error ? error.message : String(error));
      return;
    }

    this.#renderer.outputColorSpace = SRGBColorSpace;
    this.#renderer.setClearColor(0x000000, 0);
    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.#canvas.style.background = 'transparent';
    this.#scene = new Scene();
    this.#camera = new PerspectiveCamera(32, 1, 0.01, 100);
    this.#camera.position.set(0, 1.2, 2.8);
    this.#scene.add(this.#camera);

    const ambient = new AmbientLight(0xffffff, 0.9);
    const key = new DirectionalLight(0xffffff, 1.25);
    key.position.set(1.4, 2.4, 2.2);
    const fill = new DirectionalLight(0xeaf3ef, 0.25);
    fill.position.set(-1.8, 1, 1.2);
    this.#scene.add(ambient, key, fill);

    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(this);
    this.#motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.#motionPreference.addEventListener('change', this.#onMotionPreferenceChange);
    this.#canvas.addEventListener('pointerdown', this.#onPointerDown);
    this.#canvas.addEventListener('pointerup', this.#onPointerUp);
    window.addEventListener('pointermove', this.#onPointerMove, { passive: true });
    this.#resize();
    this.#lastFrameAt = performance.now();
    this.#frameHandle = requestAnimationFrame((time) => this.#frame(time));
  }

  #unmount(): void {
    this.#loadRequest += 1;
    if (this.#frameHandle !== null) cancelAnimationFrame(this.#frameHandle);
    this.#frameHandle = null;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#motionPreference?.removeEventListener('change', this.#onMotionPreferenceChange);
    this.#motionPreference = null;
    this.#canvas?.removeEventListener('pointerdown', this.#onPointerDown);
    this.#canvas?.removeEventListener('pointerup', this.#onPointerUp);
    window.removeEventListener('pointermove', this.#onPointerMove);
    this.#pointer = null;
    this.#pointerDownAt = null;
    this.disconnectAudio();
    this.#disposeModel();
    this.#scene?.clear();
    this.#renderer?.renderLists.dispose();
    this.#renderer?.dispose();
    this.#renderer?.forceContextLoss();
    this.#renderer = null;
    this.#scene = null;
    this.#camera = null;
    this.#canvas = null;
  }

  #resize(): void {
    if (!this.#renderer || !this.#camera) return;
    const rect = this.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    this.#renderer.setSize(width, height, false);
    this.#camera.aspect = width / height;
    this.#camera.updateProjectionMatrix();
  }

  async #loadModel(source: string): Promise<void> {
    const request = ++this.#loadRequest;
    this.#setStatus('loading');
    this.#disposeModel();

    const idleSrc = this.#idleAnimationSrc;
    const animationPromise = idleSrc
      ? getLoader()
          .loadAsync(idleSrc)
          .catch((error: unknown) => {
            if (this.#isCurrentLoad(request)) {
              this.dispatchEvent(
                new CustomEvent('airi-vrm-warning', {
                  detail: { message: `Idle animation unavailable: ${String(error)}` },
                }),
              );
            }
            return null;
          })
      : Promise.resolve(null);

    try {
      const [gltf, animationGltf] = await Promise.all([
        getLoader().loadAsync(source),
        animationPromise,
      ]);
      const vrm = (gltf.userData as { vrm?: VRM }).vrm;
      if (!vrm) throw new Error('VRM metadata was not found in the model');
      if (!this.#isCurrentLoad(request)) {
        VRMUtils.deepDispose(vrm.scene);
        return;
      }

      VRMUtils.removeUnnecessaryVertices(vrm.scene);
      VRMUtils.combineSkeletons(vrm.scene);
      vrm.scene.traverse((object) => {
        object.frustumCulled = false;
      });

      if (vrm.lookAt) {
        const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
        proxy.name = 'airi-look-at-proxy';
        vrm.scene.add(proxy);
      }

      const group = new Group();
      const faceFront = vrm.lookAt?.faceFront;
      if (faceFront) {
        const orientation = new Quaternion().setFromUnitVectors(
          faceFront.clone().normalize(),
          new Vector3(0, 0, 1),
        );
        group.quaternion.premultiply(orientation);
      }
      group.add(vrm.scene);
      this.#scene?.add(group);
      group.updateMatrixWorld(true);
      vrm.springBoneManager?.reset();
      this.#vrm = vrm;
      this.#group = group;
      this.#gestures = new SpeakingGestures(vrm.humanoid);
      this.#expression = new AiriVrmEmote(vrm);
      this.#colliders = createVrmInteractionColliders(vrm);
      this.#fitCamera();
      this.#applyLookAt(0.016);

      if (animationGltf) {
        const animations = (animationGltf.userData as { vrmAnimations?: VRMAnimation[] })
          .vrmAnimations;
        const animation = animations?.[0];
        if (animation) {
          const clip = createVRMAnimationClip(animation, vrm);
          reAnchorRootPositionTrack(clip, vrm);
          this.#mixer = new AnimationMixer(vrm.scene);
          this.#mixer.clipAction(clip).play();
        }
      }

      if (!this.#isCurrentLoad(request)) return;
      this.#setStatus('ready');
    } catch (error) {
      if (!this.#isCurrentLoad(request)) return;
      this.#setStatus('error', error instanceof Error ? error.message : String(error));
    }
  }

  #isCurrentLoad(request: number): boolean {
    return request === this.#loadRequest && this.isConnected;
  }

  #disposeModel(): void {
    this.#gestures?.reset();
    this.#gestures = null;
    this.#mixer?.stopAllAction();
    this.#mixer = null;
    this.#colliders?.dispose();
    this.#colliders = null;
    this.#lastInteractionAt.clear();
    if (this.#group) this.#scene?.remove(this.#group);
    if (this.#vrm) VRMUtils.deepDispose(this.#vrm.scene);
    this.#vrm = null;
    this.#group = null;
    this.#expression?.dispose();
    this.#expression = null;
    this.#baseGroupY = 0;
  }

  #fitCamera(): void {
    if (!this.#vrm || !this.#group || !this.#camera) return;
    const bounds = new Box3().setFromObject(this.#group);
    const size = new Vector3();
    const center = new Vector3();
    bounds.getSize(size);
    bounds.getCenter(center);
    const height = Math.max(size.y, 1);

    this.#group.position.set(-center.x, -center.y + height * 0.42, -center.z);
    this.#baseGroupY = this.#group.position.y;
    this.#camera.near = Math.max(0.01, height / 100);
    this.#camera.far = Math.max(20, height * 20);
    this.#camera.fov = 35;
    const portraitHeight = height * 0.52;
    const portraitDistance =
      portraitHeight / 2 / Math.tan((this.#camera.fov / 2) * (Math.PI / 180));
    this.#camera.position.set(0, height * 0.7, portraitDistance);
    this.#camera.lookAt(new Vector3(0, height * 0.66, 0));
    this.#camera.updateProjectionMatrix();
  }

  #applyLookAt(delta: number): void {
    const lookAt = this.#vrm?.lookAt;
    if (!lookAt) return;
    if (!lookAt.target) lookAt.target = new Object3D();
    const fixationTarget = this.#eyeSaccade.update(this.#gazeBase(), delta);
    lookAt.target.position.lerp(fixationTarget, 1 - Math.exp(-14 * delta));
    lookAt.update(delta);
  }

  #applyProceduralIdle(delta: number): void {
    if (!this.#group || this.#mixer) return;
    this.#time += delta;
    this.#group.position.y = this.#baseGroupY + Math.sin(this.#time * 1.15) * 0.008;
    const head = this.#vrm?.humanoid?.getNormalizedBoneNode('head');
    if (head) {
      head.rotation.y = Math.sin(this.#time * 0.55) * 0.025;
      head.rotation.x = Math.sin(this.#time * 0.8 + 0.6) * 0.012;
    }
  }

  #frame(time: number): void {
    if (!this.#renderer || !this.#scene || !this.#camera) return;
    const delta = Math.min(0.1, Math.max(0, (time - this.#lastFrameAt) / 1000));
    this.#lastFrameAt = time;
    this.#gestures?.restorePose();
    this.#mixer?.update(delta);
    this.#applyProceduralIdle(delta);

    const vrm = this.#vrm;
    if (vrm) {
      if (!this.#motionPreference?.matches) {
        this.#gestures?.update(delta, this.#lipSync.isSpeaking);
      }
      // AIRI frame order (VRMModel.vue): humanoid → lookAt → blink → emote → lipSync.
      vrm.humanoid?.update();
      this.#applyLookAt(delta);
      this.#blink.update(vrm.expressionManager, delta);
      this.#expression?.update(delta);
      this.#lipSync.update(vrm, delta);
      vrm.expressionManager?.update();
      vrm.nodeConstraintManager?.update();
      vrm.springBoneManager?.update(delta);
    }

    this.#renderer.render(this.#scene, this.#camera);
    this.#frameHandle = requestAnimationFrame((nextTime) => this.#frame(nextTime));
  }

  #setStatus(status: AiriVrmAvatarStatus, error?: string): void {
    this.#status = status;
    this.dispatchEvent(createAiriVrmStatusEvent(status, error));
  }
}

export function ensureAiriVrmAvatarElement(): void {
  if (typeof customElements === 'undefined') return;
  if (!customElements.get('airi-vrm-avatar')) {
    customElements.define('airi-vrm-avatar', AiriVrmAvatarElement);
  }
}

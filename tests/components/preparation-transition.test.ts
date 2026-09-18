// @vitest-environment jsdom

import { act, createElement, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreparationTransition } from '@/components/generation/preparation-transition';

type AnimationMock = {
  onfinish: (() => void) | null;
  cancel: ReturnType<typeof vi.fn>;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  target: Element;
};

let container: HTMLDivElement;
let root: Root | null;
let intrinsicHeight: number;
let displayedHeight: number | null;
let animations: AnimationMock[];
let animate: ReturnType<typeof vi.fn>;
let originalAnimate: PropertyDescriptor | undefined;
let observers: ResizeObserverMock[];
let reducedMotion: boolean;
let motionListener: ((event: MediaQueryListEvent) => void) | null;
let addMotionListener: ReturnType<typeof vi.fn>;
let removeMotionListener: ReturnType<typeof vi.fn>;

class ResizeObserverMock {
  observe = vi.fn();
  disconnect = vi.fn();

  constructor(private callback: ResizeObserverCallback) {
    observers.push(this);
  }

  notify() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function wrapper() {
  return container.firstElementChild as HTMLDivElement;
}

function inner() {
  return wrapper().firstElementChild as HTMLDivElement;
}

async function render(
  transitionKey: string | number = 'loading',
  children: ReactNode = createElement('input', { defaultValue: 'kept' }),
  strict = false,
  pending = false,
) {
  const element = createElement(
    PreparationTransition,
    { transitionKey, className: 'preparation-content', pending },
    children,
  );
  await act(async () => root!.render(strict ? createElement(StrictMode, null, element) : element));
}

async function renderPending(transitionKey = 'loading') {
  await render(transitionKey, undefined, false, true);
}

function notifyResize(height: number) {
  intrinsicHeight = height;
  act(() => observers.at(-1)!.notify());
}

function setReducedMotion(matches: boolean) {
  reducedMotion = matches;
  act(() => motionListener?.({ matches } as MediaQueryListEvent));
}

function finish(animation: AnimationMock) {
  act(() => animation.onfinish?.());
}

function expectNaturalLayout(element = wrapper()) {
  expect(element.style.height).toBe('');
  expect(element.style.overflow).toBe('');
  expect(element.style.minHeight).toBe('');
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  intrinsicHeight = 120;
  displayedHeight = null;
  animations = [];
  observers = [];
  reducedMotion = false;
  motionListener = null;
  addMotionListener = vi.fn((_event: string, listener: (event: MediaQueryListEvent) => void) => {
    motionListener = listener;
  });
  removeMotionListener = vi.fn((_event: string, listener: (event: MediaQueryListEvent) => void) => {
    if (motionListener === listener) motionListener = null;
  });
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      get matches() {
        return reducedMotion;
      },
      addEventListener: addMotionListener,
      removeEventListener: removeMotionListener,
    })),
  );
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  animate = vi.fn(function (
    this: Element,
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions,
  ) {
    const animation: AnimationMock = {
      onfinish: null,
      cancel: vi.fn(() => {
        displayedHeight = null;
      }),
      keyframes,
      options,
      target: this,
    };
    animations.push(animation);
    displayedHeight = parseFloat(String(keyframes[0].height));
    return animation;
  });
  originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: animate,
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const height =
      this === container.firstElementChild
        ? Math.max(displayedHeight ?? intrinsicHeight, parseFloat(this.style.minHeight) || 0)
        : intrinsicHeight;
    return {
      x: 0,
      y: 0,
      width: 320,
      height,
      top: 0,
      bottom: height,
      left: 0,
      right: 320,
      toJSON: () => ({}),
    };
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  if (originalAnimate) {
    Object.defineProperty(Element.prototype, 'animate', originalAnimate);
  } else {
    Reflect.deleteProperty(Element.prototype, 'animate');
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('PreparationTransition', () => {
  it('mounts at natural height with a stable intrinsic flow-root and no reveal animation', async () => {
    await render();

    expect(animate).not.toHaveBeenCalled();
    expect(wrapper().className).toBe('preparation-content');
    expect(wrapper().style.boxSizing).toBe('border-box');
    expect(inner().style.display).toBe('flow-root');
    expect(observers[0].observe).toHaveBeenCalledExactlyOnceWith(inner());
    expectNaturalLayout();
  });

  it('animates changed keys from the prior height to the new intrinsic height, then releases it', async () => {
    await render();
    intrinsicHeight = 280;
    await render('questions');

    expect(animate).toHaveBeenCalledExactlyOnceWith([{ height: '120px' }, { height: '280px' }], {
      duration: 240,
      easing: 'ease-out',
      fill: 'both',
    });
    expect(animations[0].target).toBe(wrapper());
    expect(wrapper().style.overflow).toBe('hidden');
    expect(wrapper().style.transform).toBe('');
    finish(animations[0]);
    expect(animations[0].cancel).toHaveBeenCalledOnce();
    expectNaturalLayout();

    intrinsicHeight = 80;
    await render('scope');
    expect(animations[1].keyframes).toEqual([{ height: '280px' }, { height: '80px' }]);
  });

  it('keeps idle descendant resizes passive and uses the latest natural height on the next key', async () => {
    await render();
    notifyResize(180);
    await render();
    notifyResize(200);

    expect(animate).not.toHaveBeenCalled();
    expectNaturalLayout();
    intrinsicHeight = 300;
    await render('questions');
    expect(animations[0].keyframes).toEqual([{ height: '200px' }, { height: '300px' }]);
  });

  it('retains wrapper, form, iframe, input value and focus across key changes', async () => {
    const children = () =>
      createElement(
        'form',
        null,
        createElement('input', { defaultValue: 'kept' }),
        createElement('iframe', { title: 'Read-only lesson' }),
      );
    await render('loading', children());
    const originalWrapper = wrapper();
    const originalInner = inner();
    const form = container.querySelector('form');
    const iframe = container.querySelector('iframe');
    const input = container.querySelector('input')!;
    input.value = 'learner answer';
    input.focus();

    intrinsicHeight = 300;
    await render('questions', children());
    expect(wrapper()).toBe(originalWrapper);
    expect(inner()).toBe(originalInner);
    expect(container.querySelectorAll('form')).toHaveLength(1);
    expect(container.querySelector('form')).toBe(form);
    expect(container.querySelectorAll('iframe')).toHaveLength(1);
    expect(container.querySelector('iframe')).toBe(iframe);
    expect(container.querySelector('input')).toBe(input);
    expect(input.value).toBe('learner answer');
    expect(document.activeElement).toBe(input);
  });

  it('rebases rapid key changes from the displayed size and ignores stale finishes', async () => {
    await render();
    intrinsicHeight = 300;
    await render('questions');
    const first = animations[0];
    const staleFinish = first.onfinish!;
    displayedHeight = 195;
    intrinsicHeight = 90;
    await render('scope');

    expect(first.cancel).toHaveBeenCalledOnce();
    expect(animations[1].keyframes).toEqual([{ height: '195px' }, { height: '90px' }]);
    act(staleFinish);
    expect(animations[1].cancel).not.toHaveBeenCalled();
    expect(wrapper().style.overflow).toBe('hidden');
    expect(animations).toHaveLength(2);
    finish(animations[1]);
    expectNaturalLayout();
  });

  it('retargets changed intrinsic size during animation without restarting for unchanged observations', async () => {
    await render();
    intrinsicHeight = 300;
    await render('questions');
    const staleFinish = animations[0].onfinish!;
    notifyResize(300);
    expect(animations).toHaveLength(1);

    displayedHeight = 210;
    notifyResize(410);
    expect(animations[0].cancel).toHaveBeenCalledOnce();
    expect(animations[1].keyframes).toEqual([{ height: '210px' }, { height: '410px' }]);
    act(staleFinish);
    expect(animations[1].cancel).not.toHaveBeenCalled();
    finish(animations[1]);
    notifyResize(460);
    expect(animations).toHaveLength(2);
    expectNaturalLayout();
  });

  it('checks the latest intrinsic size at finish before restoring auto height', async () => {
    await render();
    intrinsicHeight = 300;
    await render('questions');
    displayedHeight = 300;
    intrinsicHeight = 350;
    finish(animations[0]);

    expect(animations[1].keyframes).toEqual([{ height: '300px' }, { height: '350px' }]);
    finish(animations[1]);
    expectNaturalLayout();
  });

  it('measures intrinsic content plus wrapper padding and borders, not the animated wrapper', async () => {
    await render();
    wrapper().style.padding = '8px 12px 16px';
    wrapper().style.border = '2px solid black';
    notifyResize(120);
    intrinsicHeight = 280.5;
    await render('questions');

    expect(animations[0].keyframes).toEqual([{ height: '148px' }, { height: '308.5px' }]);
    displayedHeight = 205.25;
    notifyResize(330.75);
    expect(animations[1].keyframes).toEqual([{ height: '205.25px' }, { height: '358.75px' }]);
  });

  it('does not animate unchanged heights and supports transitions to and from empty content', async () => {
    await render();
    await render('questions');
    expect(animate).not.toHaveBeenCalled();
    intrinsicHeight = 0;
    await render('empty', null);
    expect(animations[0].keyframes).toEqual([{ height: '120px' }, { height: '0px' }]);
    finish(animations[0]);
    intrinsicHeight = 80;
    await render('scope');
    expect(animations[1].keyframes).toEqual([{ height: '0px' }, { height: '80px' }]);
  });

  it('honors reduced motion initially and animates only future keys when preference is disabled', async () => {
    reducedMotion = true;
    await render();
    intrinsicHeight = 260;
    await render('questions');
    expect(animate).not.toHaveBeenCalled();
    expectNaturalLayout();

    setReducedMotion(false);
    expect(animate).not.toHaveBeenCalled();
    intrinsicHeight = 320;
    await render('scope');
    expect(animations[0].keyframes).toEqual([{ height: '260px' }, { height: '320px' }]);
  });

  it('immediately cancels active motion when preference changes and ignores queued finishes', async () => {
    await render();
    intrinsicHeight = 300;
    await render('questions');
    const staleFinish = animations[0].onfinish!;
    displayedHeight = 190;
    setReducedMotion(true);

    expect(animations[0].cancel).toHaveBeenCalledOnce();
    expectNaturalLayout();
    act(staleFinish);
    notifyResize(350);
    intrinsicHeight = 400;
    await render('scope');
    expect(animations).toHaveLength(1);
    expectNaturalLayout();

    setReducedMotion(false);
    intrinsicHeight = 450;
    await render('lesson');
    expect(animations[1].keyframes).toEqual([{ height: '400px' }, { height: '450px' }]);
  });

  it.each(['ResizeObserver', 'animate', 'both'])(
    'retains natural layout when %s is unavailable',
    async (missing) => {
      if (missing !== 'animate') vi.stubGlobal('ResizeObserver', undefined);
      if (missing !== 'ResizeObserver') Reflect.deleteProperty(Element.prototype, 'animate');
      await render();
      intrinsicHeight = 320;
      await render('questions');

      expect(animate).not.toHaveBeenCalled();
      expect(observers).toHaveLength(missing === 'animate' ? 1 : 0);
      expectNaturalLayout();
      expect(container.querySelector('input')).not.toBeNull();
    },
  );

  it('supports jsdom and browsers without matchMedia', async () => {
    vi.stubGlobal('matchMedia', undefined);
    await render();
    intrinsicHeight = 280;
    await render('questions');

    expect(animate).toHaveBeenCalledOnce();
    finish(animations[0]);
    expectNaturalLayout();
  });

  it('supports legacy matchMedia subscriptions and removes the listener', async () => {
    const addListener = vi.fn((listener: (event: MediaQueryListEvent) => void) => {
      motionListener = listener;
    });
    const removeListener = vi.fn();
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false, addListener, removeListener })),
    );
    await render();
    intrinsicHeight = 280;
    await render('questions');
    setReducedMotion(true);
    expect(animations[0].cancel).toHaveBeenCalledOnce();
    expectNaturalLayout();
    await act(async () => root!.unmount());
    root = null;

    expect(removeListener).toHaveBeenCalledExactlyOnceWith(addListener.mock.calls[0][0]);
  });

  it('cleans up observation, media subscription and active animation on unmount', async () => {
    await render();
    intrinsicHeight = 300;
    await render('questions');
    const element = wrapper();
    const staleFinish = animations[0].onfinish!;
    const staleMotionChange = motionListener!;
    await act(async () => root!.unmount());
    root = null;

    expect(observers[0].disconnect).toHaveBeenCalledOnce();
    expect(removeMotionListener).toHaveBeenCalledExactlyOnceWith('change', staleMotionChange);
    expect(animations[0].cancel).toHaveBeenCalledOnce();
    expectNaturalLayout(element);
    act(() => {
      staleFinish();
      observers[0].notify();
      staleMotionChange({ matches: true } as MediaQueryListEvent);
    });
    expect(animations).toHaveLength(1);
    expect(animations[0].cancel).toHaveBeenCalledOnce();
  });

  it('survives StrictMode effect replay without an initial animation or leaked observers', async () => {
    await render(0, createElement('input'), true);
    expect(animate).not.toHaveBeenCalled();
    expect(observers).toHaveLength(2);
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
    intrinsicHeight = 280;
    await render(1, createElement('input'), true);

    expect(animations[0].keyframes).toEqual([{ height: '120px' }, { height: '280px' }]);
    finish(animations[0]);
    expectNaturalLayout();
  });

  describe('pending content', () => {
    it('centers intermediate loaders in the held space without stretching their intrinsic height', async () => {
      await render('questions');
      await renderPending('loading-scope');
      expect(wrapper().style.display).toBe('grid');
      expect(wrapper().style.alignItems).toBe('center');
      expect(inner().style.display).toBe('flow-root');
      await render('scope');
      expect(wrapper().style.display).toBe('');
      expect(wrapper().style.alignItems).toBe('');
    });

    it('starts at its natural height, grows passively and holds the largest observed pending size', async () => {
      intrinsicHeight = 72;
      await renderPending();
      expect(wrapper().getBoundingClientRect().height).toBe(72);
      expect(wrapper().style.minHeight).toBe('72px');
      expect(wrapper().style.overflow).toBe('');

      notifyResize(180);
      expect(wrapper().getBoundingClientRect().height).toBe(180);
      notifyResize(48);
      await renderPending('loading-scope');
      expect(wrapper().getBoundingClientRect().height).toBe(180);
      expect(wrapper().style.minHeight).toBe('180px');
      expect(animate).not.toHaveBeenCalled();
    });

    it.each([
      ['scope', 280],
      ['scope-error', 120],
    ])('holds a tall question through loading and releases smoothly to %s', async (key, height) => {
      intrinsicHeight = 360;
      await render('questions');
      const input = container.querySelector('input')!;
      input.value = 'learner answer';
      input.focus();

      intrinsicHeight = 80;
      await renderPending('loading-scope');
      expect(wrapper().style.minHeight).toBe('360px');
      expect(wrapper().getBoundingClientRect().height).toBe(360);
      notifyResize(96);
      expect(animate).not.toHaveBeenCalled();
      expect(wrapper().style.overflow).toBe('');

      intrinsicHeight = height;
      await render(key);
      expect(animations[0].keyframes).toEqual([{ height: '360px' }, { height: `${height}px` }]);
      expect(wrapper().style.minHeight).toBe('');
      expect(container.querySelector('input')).toBe(input);
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe('learner answer');
      finish(animations[0]);
      expectNaturalLayout();
      expect(wrapper().getBoundingClientRect().height).toBe(height);
    });

    it('releases the hold when pending settles without a key change', async () => {
      await renderPending();
      notifyResize(50);
      await render('loading');

      expect(animations[0].keyframes).toEqual([{ height: '120px' }, { height: '50px' }]);
      expect(wrapper().style.minHeight).toBe('');
      finish(animations[0]);
      expectNaturalLayout();
    });

    it('allows larger pending panels to grow naturally rather than clipping to the old height', async () => {
      await render('questions');
      intrinsicHeight = 260;
      await renderPending('loading-scope');
      expect(wrapper().getBoundingClientRect().height).toBe(260);
      expect(wrapper().style.minHeight).toBe('260px');
      expect(wrapper().style.overflow).toBe('');
      expect(animate).not.toHaveBeenCalled();

      intrinsicHeight = 80;
      await renderPending('loading-materials');
      expect(wrapper().getBoundingClientRect().height).toBe(260);
      expect(animate).not.toHaveBeenCalled();
    });

    it('rebases rapid pending re-entry from the displayed size and rejects stale finish callbacks', async () => {
      intrinsicHeight = 420;
      await render('questions');
      intrinsicHeight = 80;
      await renderPending('loading-scope');
      intrinsicHeight = 260;
      await render('scope');
      expect(animations[0].keyframes).toEqual([{ height: '420px' }, { height: '260px' }]);
      const staleFirstFinish = animations[0].onfinish!;

      displayedHeight = 350;
      intrinsicHeight = 80;
      await renderPending('loading-materials');
      expect(animations[0].cancel).toHaveBeenCalledOnce();
      expect(wrapper().style.minHeight).toBe('350px');
      act(staleFirstFinish);
      expect(wrapper().getBoundingClientRect().height).toBe(350);
      expect(wrapper().style.minHeight).toBe('350px');
      expect(wrapper().style.overflow).toBe('');
      expect(animations).toHaveLength(1);

      intrinsicHeight = 100;
      await renderPending('loading-outline');
      intrinsicHeight = 500;
      await render('lesson');
      expect(animations[1].keyframes).toEqual([{ height: '350px' }, { height: '500px' }]);
      const staleSecondFinish = animations[1].onfinish!;
      displayedHeight = 400;
      intrinsicHeight = 90;
      await renderPending('loading-outline');
      expect(wrapper().style.minHeight).toBe('400px');
      act(staleSecondFinish);
      expect(wrapper().style.minHeight).toBe('400px');

      intrinsicHeight = 140;
      await render('outline-error');
      expect(animations[2].keyframes).toEqual([{ height: '400px' }, { height: '140px' }]);
      finish(animations[2]);
      expectNaturalLayout();
    });

    it('keeps reduced-motion loading non-collapsing and immediately releases settled content', async () => {
      reducedMotion = true;
      intrinsicHeight = 360;
      await render('questions');
      intrinsicHeight = 80;
      await renderPending('loading-scope');
      expect(wrapper().getBoundingClientRect().height).toBe(360);
      notifyResize(420);
      notifyResize(70);
      expect(wrapper().getBoundingClientRect().height).toBe(420);

      intrinsicHeight = 120;
      await render('scope-error');
      expectNaturalLayout();
      expect(wrapper().getBoundingClientRect().height).toBe(120);
      notifyResize(100);
      intrinsicHeight = 50;
      await renderPending('loading-scope');
      expect(wrapper().style.minHeight).toBe('100px');
      expect(animate).not.toHaveBeenCalled();
    });

    it('preserves pending layout across live motion changes and cancels a release immediately', async () => {
      intrinsicHeight = 360;
      await render('questions');
      intrinsicHeight = 80;
      await renderPending('loading-scope');
      setReducedMotion(true);
      expect(wrapper().style.minHeight).toBe('360px');
      setReducedMotion(false);
      expect(wrapper().style.minHeight).toBe('360px');
      expect(animate).not.toHaveBeenCalled();

      intrinsicHeight = 220;
      await render('scope');
      const staleFinish = animations[0].onfinish!;
      displayedHeight = 300;
      setReducedMotion(true);
      expect(animations[0].cancel).toHaveBeenCalledOnce();
      expectNaturalLayout();
      intrinsicHeight = 80;
      await renderPending('loading-materials');
      act(staleFinish);
      expect(wrapper().style.minHeight).toBe('220px');

      setReducedMotion(false);
      expect(wrapper().style.minHeight).toBe('220px');
      expect(animations).toHaveLength(1);
      intrinsicHeight = 420;
      await render('lesson');
      expect(animations[1].keyframes).toEqual([{ height: '220px' }, { height: '420px' }]);
      finish(animations[1]);
      expectNaturalLayout();
    });

    it.each(['ResizeObserver', 'animate', 'both'])(
      'preserves and releases pending layout without %s',
      async (missing) => {
        if (missing !== 'animate') vi.stubGlobal('ResizeObserver', undefined);
        if (missing !== 'ResizeObserver') Reflect.deleteProperty(Element.prototype, 'animate');
        intrinsicHeight = 340;
        await render('questions');
        intrinsicHeight = 80;
        await renderPending('loading-scope');
        expect(wrapper().style.minHeight).toBe('340px');
        expect(wrapper().getBoundingClientRect().height).toBe(340);

        intrinsicHeight = 220;
        await render('scope');
        expect(animate).not.toHaveBeenCalled();
        expectNaturalLayout();
      },
    );

    it('removes the pending constraint on unmount and ignores queued observer events', async () => {
      await render('questions');
      intrinsicHeight = 40;
      await renderPending('loading-scope');
      const element = wrapper();
      expect(element.style.minHeight).toBe('120px');
      await act(async () => root!.unmount());
      root = null;

      expect(observers[0].disconnect).toHaveBeenCalledOnce();
      expect(removeMotionListener).toHaveBeenCalledOnce();
      expectNaturalLayout(element);
      act(() => observers[0].notify());
      expectNaturalLayout(element);
    });
  });
});

'use client';

import { useLayoutEffect, useRef, type ReactNode } from 'react';

interface PreparationTransitionProps {
  children?: ReactNode;
  transitionKey: string | number;
  className?: string;
  pending?: boolean;
}

export function PreparationTransition({
  children,
  transitionKey,
  className,
  pending = false,
}: PreparationTransitionProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const transitionRef = useRef<((pending: boolean) => void) | null>(null);
  const previousKeyRef = useRef(transitionKey);
  const previousPendingRef = useRef(pending);

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const inner = innerRef.current;
    if (!wrapper || !inner) return;
    const canObserve = typeof ResizeObserver === 'function';
    const canAnimate = canObserve && typeof wrapper.animate === 'function';

    const media =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    let reducedMotion = media?.matches ?? false;
    let disposed = false;
    let animation: Animation | null = null;
    let targetHeight: number | null = null;
    let isPending = previousPendingRef.current;
    let heldHeight: number | null = null;

    const measure = () => {
      // The inner stays intrinsic while the wrapper's border-box height is animated.
      const height = inner.getBoundingClientRect().height;
      const style = getComputedStyle(wrapper);
      return (
        height +
        (parseFloat(style.paddingTop) || 0) +
        (parseFloat(style.paddingBottom) || 0) +
        (parseFloat(style.borderTopWidth) || 0) +
        (parseFloat(style.borderBottomWidth) || 0)
      );
    };
    let naturalHeight = measure();

    const holdHeight = (height: number) => {
      heldHeight = Math.max(heldHeight ?? 0, height);
      wrapper.style.minHeight = `${heldHeight}px`;
    };
    if (isPending) holdHeight(naturalHeight);

    const cancel = () => {
      const previous = animation;
      animation = null;
      targetHeight = null;
      if (previous) {
        previous.onfinish = null;
        previous.cancel();
      }
      wrapper.style.removeProperty('overflow');
    };

    const animateHeight = (from: number, to: number) => {
      cancel();
      if (!canAnimate || reducedMotion || from === to) return;

      wrapper.style.overflow = 'hidden';
      const next = wrapper.animate([{ height: `${from}px` }, { height: `${to}px` }], {
        duration: 240,
        easing: 'ease-out',
        fill: 'both',
      });
      animation = next;
      targetHeight = to;
      next.onfinish = () => {
        if (disposed || animation !== next) return;
        naturalHeight = measure();
        if (naturalHeight !== targetHeight) {
          animateHeight(wrapper.getBoundingClientRect().height, naturalHeight);
        } else {
          cancel();
        }
      };
    };

    transitionRef.current = (pending) => {
      const to = measure();
      const from = animation
        ? wrapper.getBoundingClientRect().height
        : Math.max(naturalHeight, heldHeight ?? 0);
      naturalHeight = to;
      isPending = pending;
      if (isPending) {
        // Intermediate loaders may grow, but never collapse the space already shown.
        cancel();
        holdHeight(Math.max(from, to));
      } else {
        heldHeight = null;
        wrapper.style.removeProperty('min-height');
        animateHeight(from, to);
      }
    };

    const onResize = () => {
      if (disposed) return;
      const height = measure();
      naturalHeight = height;
      if (isPending) {
        holdHeight(height);
        return;
      }
      // Idle descendant resizes belong to their own transition, not this wrapper.
      if (animation && height !== targetHeight) {
        animateHeight(wrapper.getBoundingClientRect().height, height);
      }
    };
    const observer = canObserve ? new ResizeObserver(onResize) : null;
    observer?.observe(inner);

    const onMotionChange = (event: MediaQueryListEvent) => {
      if (disposed) return;
      reducedMotion = event.matches;
      if (reducedMotion) {
        naturalHeight = measure();
        if (isPending) holdHeight(naturalHeight);
        cancel();
      }
    };
    if (typeof media?.addEventListener === 'function') {
      media.addEventListener('change', onMotionChange);
    } else {
      media?.addListener?.(onMotionChange);
    }

    return () => {
      disposed = true;
      transitionRef.current = null;
      observer?.disconnect();
      if (typeof media?.removeEventListener === 'function') {
        media.removeEventListener('change', onMotionChange);
      } else {
        media?.removeListener?.(onMotionChange);
      }
      cancel();
      wrapper.style.removeProperty('min-height');
    };
  }, []);

  useLayoutEffect(() => {
    if (previousKeyRef.current === transitionKey && previousPendingRef.current === pending) return;
    previousKeyRef.current = transitionKey;
    previousPendingRef.current = pending;
    transitionRef.current?.(pending);
  }, [transitionKey, pending]);

  return (
    <div
      ref={wrapperRef}
      className={className}
      style={{
        boxSizing: 'border-box',
        display: pending ? 'grid' : undefined,
        alignItems: pending ? 'center' : undefined,
      }}
    >
      <div ref={innerRef} style={{ display: 'flow-root' }}>
        {children}
      </div>
    </div>
  );
}

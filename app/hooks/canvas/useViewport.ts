"use client";

/**
 * Viewport: zoom, scroll, canvas sizing and wheel handling.
 *
 * The wheel listener is attached natively with `{ passive: false }`. React's
 * synthetic `onWheel` is registered passively, so the previous
 * `e.preventDefault()` inside it was ignored by the browser and the page
 * scrolled while zooming.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  type BoundingBox,
  type Viewport,
} from "../../types/shapes";
import {
  clampZoom,
  INITIAL_VIEWPORT,
  scrollToFit,
  zoomAtCenter,
  zoomAtPoint,
} from "../../utils/viewport";

export interface CanvasSize {
  width: number;
  height: number;
}

export interface UseViewportResult {
  viewport: Viewport;
  viewportRef: React.MutableRefObject<Viewport>;
  setViewport: React.Dispatch<React.SetStateAction<Viewport>>;
  size: CanvasSize;
  devicePixelRatio: number;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  zoomToFit: (bounds: BoundingBox | null) => void;
  scrollBy: (dx: number, dy: number) => void;
}

const ZOOM_STEP = 1.1;

export const useViewport = (
  containerRef: React.RefObject<HTMLElement | null>,
): UseViewportResult => {
  const [viewport, setViewport] = useState<Viewport>(INITIAL_VIEWPORT);
  const [size, setSize] = useState<CanvasSize>({ width: 0, height: 0 });
  const [devicePixelRatio, setDevicePixelRatio] = useState(1);

  const viewportRef = useRef<Viewport>(viewport);
  viewportRef.current = viewport;

  const sizeRef = useRef(size);
  sizeRef.current = size;

  /* Track the container's CSS size. The old code only re-measured when the
   * `width`/`height` props changed, so the canvas never followed its container. */
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const measure = () => {
      const rect = container.getBoundingClientRect();
      setSize((current) =>
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height },
      );
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(container);

    return () => observer.disconnect();
  }, [containerRef]);

  /* Follow DPR changes (moving a window between displays, browser zoom). */
  useEffect(() => {
    const update = () => setDevicePixelRatio(window.devicePixelRatio || 1);
    update();

    const query = window.matchMedia(
      `(resolution: ${window.devicePixelRatio || 1}dppx)`,
    );
    query.addEventListener("change", update);
    window.addEventListener("resize", update);

    return () => {
      query.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  /* Wheel: ctrl/cmd zooms about the cursor, otherwise scroll. */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();

      const rect = container.getBoundingClientRect();
      const anchor = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };

      if (event.ctrlKey || event.metaKey) {
        // Trackpad pinch arrives as ctrl+wheel with small deltas; the
        // exponential form keeps the response even across input devices.
        const factor = Math.exp(-event.deltaY / 100);
        setViewport((current) =>
          zoomAtPoint(current, current.zoom * factor, anchor),
        );
        return;
      }

      const { deltaX, deltaY } = event;
      setViewport((current) => ({
        ...current,
        scroll: {
          x: current.scroll.x - (event.shiftKey ? deltaY : deltaX) / current.zoom,
          y: current.scroll.y - (event.shiftKey ? 0 : deltaY) / current.zoom,
        },
      }));
    };

    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [containerRef]);

  const zoomIn = useCallback(() => {
    setViewport((current) =>
      zoomAtCenter(current, current.zoom * ZOOM_STEP, sizeRef.current),
    );
  }, []);

  const zoomOut = useCallback(() => {
    setViewport((current) =>
      zoomAtCenter(current, current.zoom / ZOOM_STEP, sizeRef.current),
    );
  }, []);

  const resetZoom = useCallback(() => {
    setViewport((current) => zoomAtCenter(current, 1, sizeRef.current));
  }, []);

  const zoomToFit = useCallback((bounds: BoundingBox | null) => {
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      setViewport(INITIAL_VIEWPORT);
      return;
    }
    setViewport(scrollToFit(bounds, sizeRef.current));
  }, []);

  const scrollBy = useCallback((dx: number, dy: number) => {
    setViewport((current) => ({
      ...current,
      scroll: {
        x: current.scroll.x - dx / current.zoom,
        y: current.scroll.y - dy / current.zoom,
      },
    }));
  }, []);

  return {
    viewport,
    viewportRef,
    setViewport,
    size,
    devicePixelRatio,
    zoomIn,
    zoomOut,
    resetZoom,
    zoomToFit,
    scrollBy,
  };
};

export { MIN_ZOOM, MAX_ZOOM, clampZoom };

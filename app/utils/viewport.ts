/**
 * The single screen <-> world coordinate transform for the whole editor.
 *
 * Convention (same as Excalidraw): `scroll` is in world units and zoom is
 * applied after scrolling, so
 *
 *   screenCss = (world + scroll) * zoom
 *   world     = screenCss / zoom - scroll
 *
 * The renderer applies exactly this as a canvas transform, including the device
 * pixel ratio, which is why pointer maths and rendering can never drift apart.
 */
import { MAX_ZOOM, MIN_ZOOM, type Point, type Viewport } from "../types/shapes";
import { clamp } from "./geometry";

export const INITIAL_VIEWPORT: Viewport = { zoom: 1, scroll: { x: 0, y: 0 } };

export const clampZoom = (zoom: number): number =>
  clamp(zoom, MIN_ZOOM, MAX_ZOOM);

/** Screen coordinates relative to the canvas element -> world coordinates. */
export const screenToWorld = (
  screenX: number,
  screenY: number,
  viewport: Viewport,
): Point => ({
  x: screenX / viewport.zoom - viewport.scroll.x,
  y: screenY / viewport.zoom - viewport.scroll.y,
});

/** World coordinates -> screen coordinates relative to the canvas element. */
export const worldToScreen = (
  worldX: number,
  worldY: number,
  viewport: Viewport,
): Point => ({
  x: (worldX + viewport.scroll.x) * viewport.zoom,
  y: (worldY + viewport.scroll.y) * viewport.zoom,
});

/** Convert a pointer event's client coordinates into world coordinates. */
export const clientToWorld = (
  clientX: number,
  clientY: number,
  rect: DOMRect,
  viewport: Viewport,
): Point => screenToWorld(clientX - rect.left, clientY - rect.top, viewport);

/**
 * Zoom while keeping the world point currently under `anchor` (screen space)
 * pinned in place. This is what makes ctrl+wheel and pinch feel right.
 */
export const zoomAtPoint = (
  viewport: Viewport,
  nextZoom: number,
  anchor: Point,
): Viewport => {
  const zoom = clampZoom(nextZoom);

  if (zoom === viewport.zoom) {
    return viewport;
  }

  const worldAnchor = screenToWorld(anchor.x, anchor.y, viewport);

  return {
    zoom,
    scroll: {
      x: anchor.x / zoom - worldAnchor.x,
      y: anchor.y / zoom - worldAnchor.y,
    },
  };
};

/** Zoom about the centre of a viewport of the given CSS size. */
export const zoomAtCenter = (
  viewport: Viewport,
  nextZoom: number,
  size: { width: number; height: number },
): Viewport =>
  zoomAtPoint(viewport, nextZoom, {
    x: size.width / 2,
    y: size.height / 2,
  });

/** A distance in screen pixels expressed in world units at the current zoom. */
export const screenDistanceToWorld = (
  pixels: number,
  viewport: Viewport,
): number => pixels / viewport.zoom;

/**
 * Apply the viewport (and device pixel ratio) to a 2D context so that
 * subsequent drawing can use world coordinates directly.
 */
export const applyViewportTransform = (
  context: CanvasRenderingContext2D,
  viewport: Viewport,
  devicePixelRatio: number,
): void => {
  const scale = devicePixelRatio * viewport.zoom;
  context.setTransform(
    scale,
    0,
    0,
    scale,
    scale * viewport.scroll.x,
    scale * viewport.scroll.y,
  );
};

/** The world-space rectangle currently visible, used to cull off-screen work. */
export const getVisibleWorldBounds = (
  viewport: Viewport,
  size: { width: number; height: number },
  padding = 0,
) => {
  const topLeft = screenToWorld(-padding, -padding, viewport);
  const bottomRight = screenToWorld(
    size.width + padding,
    size.height + padding,
    viewport,
  );

  return {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  };
};

/** Centre the viewport on a world-space box, fitting it with some margin. */
export const scrollToFit = (
  box: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number },
  margin = 64,
): Viewport => {
  if (box.width <= 0 || box.height <= 0 || size.width <= 0 || size.height <= 0) {
    return INITIAL_VIEWPORT;
  }

  const zoom = clampZoom(
    Math.min(
      (size.width - margin * 2) / box.width,
      (size.height - margin * 2) / box.height,
      1,
    ),
  );

  return {
    zoom,
    scroll: {
      x: size.width / (2 * zoom) - (box.x + box.width / 2),
      y: size.height / (2 * zoom) - (box.y + box.height / 2),
    },
  };
};

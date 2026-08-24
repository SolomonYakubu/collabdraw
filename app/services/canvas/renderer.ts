/**
 * Scene rendering.
 *
 * Two layers, like Excalidraw:
 *  - the static layer holds the elements themselves. rough.js drawables are
 *    generated once per element and cached, so moving the pointer no longer
 *    re-randomises and re-tessellates the whole scene every frame.
 *  - the interactive layer holds selection, handles, guides, binding
 *    highlights, the eraser trail and remote cursors. It is cheap to repaint.
 */
import rough from "roughjs";
import type { RoughCanvas } from "roughjs/bin/canvas";
import type { RoughGenerator } from "roughjs/bin/generator";
import type { Drawable, Options } from "roughjs/bin/core";
import getStroke from "perfect-freehand";

import {
  isLinearShape,
  type BoundingBox,
  type Point,
  type Shape,
  type TextShape,
  type Viewport,
  type AlignmentGuide,
  type TransformHandle,
} from "../../types/shapes";
import {
  boxCenter,
  diamondPoints,
  rotatePoint,
  trianglePoints,
} from "../../utils/geometry";
import { applyViewportTransform, getVisibleWorldBounds } from "../../utils/viewport";
import { getElementBounds, getElementCenter, getRotatedBounds } from "./elements";
import { getSelectionAngle, getTransformHandles } from "./hitTest";
import {
  getEndDirection,
  getLinearPath,
  roundedPathD,
} from "./linearElement";
import { getFontString, getLineHeight, getTextLines } from "./textMeasure";

const SELECTION_COLOR = "#6965db";
const SELECTION_FILL = "rgba(105, 101, 219, 0.1)";
const BINDING_HIGHLIGHT = "#6965db";
const GUIDE_COLOR = "#ff6b6b";
const SNAP_COLOR = "#12b886";
const ERASER_PREVIEW_OPACITY = 0.25;

let generator: RoughGenerator | null = null;

const getGenerator = (): RoughGenerator => {
  if (!generator) {
    generator = rough.generator();
  }
  return generator;
};

/**
 * Generated geometry, cached per element *object*.
 *
 * Elements are immutable, so object identity is an exact cache key: any change
 * produces a new object and therefore a miss, while an untouched element keeps
 * its drawables for free. Keying on `element.version` would not work — a drag
 * derives each frame from the snapshot taken when the gesture began, so the
 * version is constant throughout and the shape would render frozen at its
 * starting position. A WeakMap also means there is nothing to evict.
 */
const drawableCache = new WeakMap<Shape, Drawable[]>();
const freehandCache = new WeakMap<Shape, Path2D>();

const getStrokeLineDash = (element: Shape): number[] | undefined => {
  switch (element.strokeStyle) {
    case "dashed":
      return [8 + element.strokeWidth * 3, 8 + element.strokeWidth * 3];
    case "dotted":
      return [1.5, 6 + element.strokeWidth * 3];
    default:
      return undefined;
  }
};

const hasBackground = (element: Shape): boolean =>
  element.fill !== "transparent" && element.fill !== "" && element.fill !== "none";

const getRoughOptions = (element: Shape): Options => {
  const options: Options = {
    seed: element.seed,
    strokeWidth: element.strokeWidth,
    stroke: element.stroke,
    roughness: element.roughness,
    // A little bowing at higher roughness reads as hand-drawn without wobbling.
    bowing: element.roughness === 0 ? 0 : 1,
    curveFitting: 0.95,
    // Keeps endpoints exactly where the model says they are, which matters for
    // arrows whose ends are bound to shapes.
    preserveVertices: true,
    disableMultiStroke: element.roughness === 0,
  };

  const dash = getStrokeLineDash(element);
  if (dash) {
    options.strokeLineDash = dash;
  }

  if (hasBackground(element)) {
    options.fill = element.fill;
    options.fillStyle = element.fillStyle;
    options.fillWeight = element.strokeWidth / 2;
    options.hachureGap = element.strokeWidth * 4;
    // Derived from the seed so the hatching is stable across redraws.
    options.hachureAngle = -41 + (element.seed % 40);
  }

  return options;
};

const ARROWHEAD_ANGLE = Math.PI / 7;

const buildDrawables = (element: Shape): Drawable[] => {
  const gen = getGenerator();
  const options = getRoughOptions(element);
  const bounds = getElementBounds(element);

  switch (element.tool) {
    case "Square":
      return [
        gen.rectangle(bounds.x, bounds.y, bounds.width, bounds.height, options),
      ];

    case "Circle":
      return [
        gen.ellipse(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
          bounds.width,
          bounds.height,
          options,
        ),
      ];

    case "Diamond":
    case "Triangle": {
      const points =
        element.tool === "Diamond"
          ? diamondPoints(bounds)
          : trianglePoints(bounds);
      const polygon: Array<[number, number]> = [];
      for (let i = 0; i < points.length; i += 2) {
        polygon.push([points[i], points[i + 1]]);
      }
      return [gen.polygon(polygon, options)];
    }

    case "Line":
    case "Arrow": {
      const path = getLinearPath(element);

      if (path.length < 2) {
        return [];
      }

      const drawables: Drawable[] = [];

      if (element.edgeStyle === "elbow") {
        // Rounded corners, so the bends read as a smooth turn rather than a
        // hard right angle.
        drawables.push(gen.path(roundedPathD(path), options));
      } else if (element.edgeStyle === "curved" && path.length > 2) {
        drawables.push(
          gen.curve(
            path.map((point) => [point.x, point.y] as [number, number]),
            options,
          ),
        );
      } else {
        drawables.push(
          gen.linearPath(
            path.map((point) => [point.x, point.y] as [number, number]),
            options,
          ),
        );
      }

      if (element.tool === "Line") {
        return drawables;
      }

      // Arrowheads follow the direction of the segment they sit on, so they
      // stay aligned however the line bends.
      const span = Math.hypot(
        path[path.length - 1].x - path[0].x,
        path[path.length - 1].y - path[0].y,
      );

      if (span < 1) {
        return drawables;
      }

      const size = Math.min(
        18 + element.strokeWidth * 2,
        Math.max(8, span / 2),
      );

      const head = (tip: Point, angle: number): Drawable[] => [
        gen.line(
          tip.x,
          tip.y,
          tip.x - size * Math.cos(angle - ARROWHEAD_ANGLE),
          tip.y - size * Math.sin(angle - ARROWHEAD_ANGLE),
          options,
        ),
        gen.line(
          tip.x,
          tip.y,
          tip.x - size * Math.cos(angle + ARROWHEAD_ANGLE),
          tip.y - size * Math.sin(angle + ARROWHEAD_ANGLE),
          options,
        ),
      ];

      if (element.endArrowhead !== false) {
        drawables.push(
          ...head(path[path.length - 1], getEndDirection(path, "end")),
        );
      }
      if (element.startArrowhead) {
        drawables.push(...head(path[0], getEndDirection(path, "start")));
      }

      return drawables;
    }

    default:
      return [];
  }
};

const getDrawables = (element: Shape): Drawable[] => {
  const cached = drawableCache.get(element);

  if (cached) {
    return cached;
  }

  const drawables = buildDrawables(element);
  drawableCache.set(element, drawables);
  return drawables;
};

/** Freehand outline as a cached Path2D, built with perfect-freehand. */
const getFreehandPath = (element: Shape): Path2D | null => {
  if (element.tool !== "Freehand" || element.points.length < 2) {
    return null;
  }

  const cached = freehandCache.get(element);
  if (cached) {
    return cached;
  }

  const input: Array<[number, number]> = [];
  for (let i = 0; i + 1 < element.points.length; i += 2) {
    input.push([element.points[i], element.points[i + 1]]);
  }

  const outline = getStroke(input, {
    size: element.strokeWidth * 4.25,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: input.length === 1,
    last: true,
  });

  if (outline.length === 0) {
    return null;
  }

  const path = new Path2D();
  path.moveTo(outline[0][0], outline[0][1]);

  // Quadratic segments through the midpoints give a smooth, closed outline.
  for (let i = 1; i < outline.length; i += 1) {
    const [x0, y0] = outline[i - 1];
    const [x1, y1] = outline[i];
    path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }

  path.closePath();

  freehandCache.set(element, path);
  return path;
};

const drawTextElement = (
  context: CanvasRenderingContext2D,
  element: TextShape,
): void => {
  if (!element.text) {
    return;
  }

  context.font = getFontString(element.fontSize, element.fontFamily);
  context.fillStyle = element.stroke;
  context.textBaseline = "top";
  context.textAlign = element.textAlign;

  const lines = getTextLines(element);
  const lineHeight = getLineHeight(element.fontSize);
  const blockHeight = lines.length * lineHeight;

  const originX =
    element.textAlign === "center"
      ? element.x + element.width / 2
      : element.textAlign === "right"
        ? element.x + element.width
        : element.x;

  const originY =
    element.verticalAlign === "middle"
      ? element.y + (element.height - blockHeight) / 2
      : element.y;

  lines.forEach((line, index) => {
    context.fillText(line, originX, originY + index * lineHeight);
  });

  // Reset so later draws are not affected.
  context.textAlign = "left";
};

/** Draw a single element in world coordinates. */
export const drawElement = (
  roughCanvas: RoughCanvas,
  context: CanvasRenderingContext2D,
  element: Shape,
  options: { previewOpacity?: number } = {},
): void => {
  if (element.isDeleted) {
    return;
  }

  context.save();

  // Rotation is applied to the context rather than baked into the geometry, so
  // the stored coordinates stay the element's own unrotated frame — which is
  // what hit testing, snapping and binding all work in.
  if (element.angle !== 0) {
    const center = getElementCenter(element);
    context.translate(center.x, center.y);
    context.rotate(element.angle);
    context.translate(-center.x, -center.y);
  }

  const baseAlpha = Math.max(0, Math.min(1, element.opacity / 100));
  context.globalAlpha = baseAlpha * (options.previewOpacity ?? 1);

  if (element.isInProgress) {
    // Remote in-progress shapes read as provisional.
    context.globalAlpha *= 0.6;
  }

  if (element.tool === "Text") {
    drawTextElement(context, element as TextShape);
  } else if (element.tool === "Freehand") {
    const path = getFreehandPath(element);
    if (path) {
      context.fillStyle = element.stroke;
      context.fill(path);
    }
  } else {
    for (const drawable of getDrawables(element)) {
      roughCanvas.draw(drawable);
    }
  }

  context.restore();
};

export interface StaticSceneParams {
  canvas: HTMLCanvasElement;
  roughCanvas: RoughCanvas;
  elements: readonly Shape[];
  viewport: Viewport;
  devicePixelRatio: number;
  /** Elements the eraser is currently hovering; drawn faded, not yet deleted. */
  erasingIds?: ReadonlySet<string>;
  /** The element being drawn right now, not yet committed to the scene. */
  pendingElement?: Shape | null;
}

export const renderStaticScene = ({
  canvas,
  roughCanvas,
  elements,
  viewport,
  devicePixelRatio,
  erasingIds,
  pendingElement,
}: StaticSceneParams): void => {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  applyViewportTransform(context, viewport, devicePixelRatio);

  // Cull anything outside the viewport; the padding covers stroke overhang.
  const visible = getVisibleWorldBounds(
    viewport,
    { width: canvas.width / devicePixelRatio, height: canvas.height / devicePixelRatio },
    64,
  );

  for (const element of elements) {
    // The stored box is kept in sync with the geometry by `normalizeElement`, so
    // culling can use it directly rather than re-deriving bounds — which for a
    // freehand stroke means walking every point, every frame. A rotated element
    // needs its on-screen extent instead.
    const extent =
      element.angle === 0
        ? {
            x: element.x,
            y: element.y,
            width: element.width,
            height: element.height,
          }
        : getRotatedBounds(element);

    const offscreen =
      extent.x > visible.x + visible.width ||
      extent.x + extent.width < visible.x ||
      extent.y > visible.y + visible.height ||
      extent.y + extent.height < visible.y;

    if (offscreen) {
      continue;
    }

    drawElement(roughCanvas, context, element, {
      previewOpacity: erasingIds?.has(element.id) ? ERASER_PREVIEW_OPACITY : 1,
    });
  }

  if (pendingElement) {
    drawElement(roughCanvas, context, pendingElement);
  }

  context.setTransform(1, 0, 0, 1, 0, 0);
};

/** Rotate the context about a pivot for the duration of a callback. */
const withRotation = (
  context: CanvasRenderingContext2D,
  pivot: Point,
  angle: number,
  draw: () => void,
): void => {
  if (angle === 0) {
    draw();
    return;
  }

  context.save();
  context.translate(pivot.x, pivot.y);
  context.rotate(angle);
  context.translate(-pivot.x, -pivot.y);
  draw();
  context.restore();
};

const strokeRectWorld = (
  context: CanvasRenderingContext2D,
  box: BoundingBox,
  zoom: number,
  { dash = true, padding = 4 }: { dash?: boolean; padding?: number } = {},
): void => {
  const pad = padding / zoom;
  context.lineWidth = 1 / zoom;
  context.strokeStyle = SELECTION_COLOR;
  context.setLineDash(dash ? [4 / zoom, 4 / zoom] : []);
  context.strokeRect(
    box.x - pad,
    box.y - pad,
    box.width + pad * 2,
    box.height + pad * 2,
  );
  context.setLineDash([]);
};

const drawHandles = (
  context: CanvasRenderingContext2D,
  elements: readonly Shape[],
  bounds: BoundingBox,
  zoom: number,
): void => {
  const handles = getTransformHandles(elements, bounds, zoom);
  const isLinear = elements.length === 1 && isLinearShape(elements[0]);
  const angle = getSelectionAngle(elements);
  const pivot = boxCenter(bounds);

  context.lineWidth = 1 / zoom;
  context.strokeStyle = SELECTION_COLOR;
  context.fillStyle = "#ffffff";

  // The line joining the rotation handle to the shape, so it reads as attached.
  const rotateHandle = handles.find((handle) => handle.name === "rotate");
  if (rotateHandle) {
    const top = rotatePoint(
      { x: bounds.x + bounds.width / 2, y: bounds.y },
      pivot,
      angle,
    );

    context.beginPath();
    context.moveTo(top.x, top.y);
    context.lineTo(rotateHandle.center.x, rotateHandle.center.y);
    context.stroke();
  }

  for (const handle of handles) {
    const { center } = handle;
    const radius = handle.width / 2;

    context.beginPath();

    if (handle.name === "rotate" || isLinear) {
      // Round for anything that is grabbed and moved rather than dragged along
      // an axis: the rotation grip and a line's endpoints.
      context.arc(center.x, center.y, radius, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      continue;
    }

    // Square handles turn with the selection, so they sit flush on its edges.
    withRotation(context, center, angle, () => {
      context.beginPath();
      context.rect(handle.x, handle.y, handle.width, handle.height);
      context.fill();
      context.stroke();
    });
  }
};

export interface InteractiveSceneParams {
  canvas: HTMLCanvasElement;
  viewport: Viewport;
  devicePixelRatio: number;
  selectedElements: readonly Shape[];
  selectionBounds: BoundingBox | null;
  /** True while a transform is in progress, so the outline is drawn solid. */
  isTransforming?: boolean;
  showHandles?: boolean;
  marquee?: BoundingBox | null;
  /** Shape the pointer could bind an arrow to right now. */
  bindingHighlightElement?: Shape | null;
  alignmentGuides?: readonly AlignmentGuide[];
  eraserTrail?: readonly Point[];
  activeHandle?: TransformHandle | null;
  /** Vertex an endpoint is locked onto, so it is obvious the join is exact. */
  snapPoint?: Point | null;
}

export const renderInteractiveScene = ({
  canvas,
  viewport,
  devicePixelRatio,
  selectedElements,
  selectionBounds,
  isTransforming = false,
  showHandles = true,
  marquee,
  bindingHighlightElement,
  alignmentGuides,
  eraserTrail,
  snapPoint,
}: InteractiveSceneParams): void => {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  applyViewportTransform(context, viewport, devicePixelRatio);

  const { zoom } = viewport;

  if (bindingHighlightElement) {
    const bounds = getElementBounds(bindingHighlightElement);
    const pad = 6 / zoom;
    context.save();
    context.strokeStyle = BINDING_HIGHLIGHT;
    context.lineWidth = 3 / zoom;
    context.globalAlpha = 0.55;
    withRotation(
      context,
      boxCenter(bounds),
      bindingHighlightElement.angle,
      () => {
        context.strokeRect(
          bounds.x - pad,
          bounds.y - pad,
          bounds.width + pad * 2,
          bounds.height + pad * 2,
        );
      },
    );
    context.restore();
  }

  if (alignmentGuides && alignmentGuides.length > 0) {
    context.save();
    context.strokeStyle = GUIDE_COLOR;
    context.lineWidth = 1 / zoom;
    context.setLineDash([6 / zoom, 4 / zoom]);

    for (const guide of alignmentGuides) {
      context.beginPath();
      if (guide.orientation === "vertical") {
        context.moveTo(guide.position, guide.from);
        context.lineTo(guide.position, guide.to);
      } else {
        context.moveTo(guide.from, guide.position);
        context.lineTo(guide.to, guide.position);
      }
      context.stroke();
    }

    context.restore();
  }

  // Individual outlines when several elements are selected, so it is obvious
  // what is included; a single element only gets the combined box.
  if (selectedElements.length > 1) {
    context.save();
    context.globalAlpha = 0.75;
    for (const element of selectedElements) {
      const box = getElementBounds(element);
      withRotation(context, boxCenter(box), element.angle, () => {
        strokeRectWorld(context, box, zoom, { padding: 2 });
      });
    }
    context.restore();
  }

  if (selectionBounds) {
    context.save();

    const selectionAngle = getSelectionAngle(selectedElements);
    withRotation(context, boxCenter(selectionBounds), selectionAngle, () => {
      strokeRectWorld(context, selectionBounds, zoom, { dash: !isTransforming });
    });

    if (showHandles) {
      drawHandles(context, selectedElements, selectionBounds, zoom);
    }

    context.restore();
  }

  if (marquee && (marquee.width > 0 || marquee.height > 0)) {
    context.save();
    context.fillStyle = SELECTION_FILL;
    context.strokeStyle = SELECTION_COLOR;
    context.lineWidth = 1 / zoom;
    context.fillRect(marquee.x, marquee.y, marquee.width, marquee.height);
    context.strokeRect(marquee.x, marquee.y, marquee.width, marquee.height);
    context.restore();
  }

  if (snapPoint) {
    // A crosshair rather than a dot: it reads as "exactly here".
    const size = 6 / zoom;
    context.save();
    context.strokeStyle = SNAP_COLOR;
    context.lineWidth = 1.5 / zoom;
    context.beginPath();
    context.moveTo(snapPoint.x - size, snapPoint.y);
    context.lineTo(snapPoint.x + size, snapPoint.y);
    context.moveTo(snapPoint.x, snapPoint.y - size);
    context.lineTo(snapPoint.x, snapPoint.y + size);
    context.stroke();
    context.beginPath();
    context.arc(snapPoint.x, snapPoint.y, size * 0.55, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }

  if (eraserTrail && eraserTrail.length > 1) {
    context.save();
    context.strokeStyle = "rgba(0, 0, 0, 0.25)";
    context.lineWidth = 4 / zoom;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(eraserTrail[0].x, eraserTrail[0].y);
    for (let i = 1; i < eraserTrail.length; i += 1) {
      context.lineTo(eraserTrail[i].x, eraserTrail[i].y);
    }
    context.stroke();
    context.restore();
  }

  context.setTransform(1, 0, 0, 1, 0, 0);
};

/**
 * Export the scene to a PNG data URL, cropped to the drawing with a margin.
 * Rendered off-screen so the export is independent of the current viewport.
 */
export const exportSceneToDataURL = (
  elements: readonly Shape[],
  {
    background = "#ffffff",
    padding = 24,
    scale = 2,
    maxDimension,
    format = "png",
    quality = 0.92,
  }: {
    background?: string;
    padding?: number;
    scale?: number;
    /** Cap the longest side, for a snapshot that has to fit in a payload. */
    maxDimension?: number;
    /**
     * PNG is lossless but heavy in base64; JPEG trades crispness for a much
     * smaller payload when the picture is going to a model rather than a file.
     */
    format?: "png" | "jpeg";
    /** JPEG quality, ignored for PNG. */
    quality?: number;
  } = {},
): string | null => {
  const visible = elements.filter((element) => !element.isDeleted);

  if (visible.length === 0) {
    return null;
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const element of visible) {
    const bounds = getElementBounds(element);
    const slop = element.strokeWidth * 2;
    minX = Math.min(minX, bounds.x - slop);
    minY = Math.min(minY, bounds.y - slop);
    maxX = Math.max(maxX, bounds.x + bounds.width + slop);
    maxY = Math.max(maxY, bounds.y + bounds.height + slop);
  }

  const width = Math.max(1, maxX - minX + padding * 2);
  const height = Math.max(1, maxY - minY + padding * 2);

  const effectiveScale = maxDimension
    ? Math.min(scale, maxDimension / Math.max(width, height))
    : scale;

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width * effectiveScale));
  canvas.height = Math.max(1, Math.ceil(height * effectiveScale));

  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.setTransform(effectiveScale, 0, 0, effectiveScale, 0, 0);
  context.translate(padding - minX, padding - minY);

  const roughCanvas = rough.canvas(canvas);

  for (const element of visible) {
    // Never export the provisional styling of someone else's in-flight shape.
    drawElement(roughCanvas, context, { ...element, isInProgress: false });
  }

  return format === "jpeg"
    ? canvas.toDataURL("image/jpeg", quality)
    : canvas.toDataURL("image/png");
};

/**
 * Drawing service for rough.js canvas drawing
 */
import { RoughCanvas } from "roughjs/bin/canvas";
import { Options } from "roughjs/bin/core";
import getStroke from "perfect-freehand";
import {
  Shape,
  FreehandShape,
  LineShape,
  ArrowShape,
  SquareShape,
  CircleShape,
  TextShape,
  DiamondShape,
  BoundingBox,
  SerializedShape,
} from "../../types/shapes";

// Default rough.js options for that sketchy hand-drawn look
export const defaultRoughOptions: Options = {
  roughness: 1.5, // Increased for more hand-drawn feel
  stroke: "#000000",
  strokeWidth: 2,
  fillStyle: "solid",
  fillWeight: 1,
  hachureGap: 8,
  bowing: 1, // Add slight curve to lines
  curveFitting: 0.95, // Smoother curves
  curveStepCount: 9, // More points for smoother curves
  seed: 0, // Deterministic seed for consistent rendering
};

/**
 * Generate a unique ID for shapes
 */
export const generateShapeId = (): string => {
  return `shape_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
};

/**
 * Convert canvas content to a data URL
 */
export const canvasToDataURL = (canvas: HTMLCanvasElement): string => {
  return canvas.toDataURL("image/png");
};

/**
 * Create a new shape
 */
export const createShape = (
  type: Shape["tool"],
  attrs: any,
  color: string
): Shape | null => {
  const baseShape = {
    id: generateShapeId(),
    stroke: color,
    strokeWidth: 2,
    fill: "transparent", // Add default fill
    roughOptions: {
      ...defaultRoughOptions,
      stroke: color,
    },
  };

  switch (type) {
    case "Freehand":
      return {
        ...baseShape,
        tool: "Freehand",
        points: attrs.points || [],
        x: attrs.x,
        y: attrs.y,
      } as FreehandShape;

    case "Line":
      return {
        ...baseShape,
        tool: "Line",
        x: attrs.x || Math.min(attrs.x1 || 0, attrs.x2 || 0),
        y: attrs.y || Math.min(attrs.y1 || 0, attrs.y2 || 0),
        x1: attrs.x1 || attrs.x,
        y1: attrs.y1 || attrs.y,
        x2: attrs.x2 || attrs.x,
        y2: attrs.y2 || attrs.y,
        points: attrs.points || [],
      } as LineShape;

    case "Arrow":
      return {
        ...baseShape,
        tool: "Arrow",
        x: attrs.x || Math.min(attrs.x1, attrs.x2) || 0,
        y: attrs.y || Math.min(attrs.y1, attrs.y2) || 0,
        x1: attrs.x1 || attrs.x,
        y1: attrs.y1 || attrs.y,
        x2: attrs.x2 || attrs.x,
        y2: attrs.y2 || attrs.y,
        points: attrs.points || [],
        arrowSize: 12,
      } as ArrowShape;

    case "Square":
      return {
        ...baseShape,
        tool: "Square",
        x: attrs.x,
        y: attrs.y,
        width: attrs.width || 0,
        height: attrs.height || 0,
        fill: attrs.fill || "transparent",
        points: attrs.points || [],
      } as SquareShape;

    case "Circle":
      return {
        ...baseShape,
        tool: "Circle",
        x: attrs.x,
        y: attrs.y,
        width: attrs.width || 0,
        height: attrs.height || 0,
        fill: attrs.fill || "transparent",
        points: attrs.points || [],
      } as CircleShape;

    case "Diamond":
      return {
        ...baseShape,
        tool: "Diamond",
        x: attrs.x,
        y: attrs.y,
        width: attrs.width || 0,
        height: attrs.height || 0,
        fill: attrs.fill || "transparent",
        points: attrs.points || [],
      } as DiamondShape;

    case "Text":
      return {
        ...baseShape,
        tool: "Text",
        x: attrs.x,
        y: attrs.y,
        text: "", // Start with empty text
        fontSize: attrs.fontSize || 20,
        fontFamily: attrs.fontFamily || "Comic Sans MS",
        fill: color,
        roughOptions: {
          ...defaultRoughOptions,
          roughness: 0.5, // Less rough for text
        },
      } as TextShape;

    default:
      return null;
  }
};

/**
 * Get rough.js options for a shape
 */
export const getRoughOptions = (shape: Shape): Options => {
  const roughOptions: Options = {
    ...defaultRoughOptions,
    stroke: shape.stroke,
    strokeWidth: shape.strokeWidth,
  };

  if (shape.fill && shape.fill !== "transparent") {
    roughOptions.fill = shape.fill;
    roughOptions.fillStyle = shape.roughOptions?.fillStyle || "hachure";

    // If the shape has a preset hachureAngle or gap, preserve it
    if (shape.roughOptions?.hachureAngle !== undefined) {
      roughOptions.hachureAngle = shape.roughOptions.hachureAngle;
    }
    if (shape.roughOptions?.hachureGap !== undefined) {
      roughOptions.hachureGap = shape.roughOptions.hachureGap;
    }
    if (shape.roughOptions?.fillWeight !== undefined) {
      roughOptions.fillWeight = shape.roughOptions.fillWeight;
    }
    if (shape.roughOptions?.roughness !== undefined) {
      roughOptions.roughness = shape.roughOptions.roughness;
    }
  }

  // Combine with any specific roughOptions from the shape
  if (shape.roughOptions) {
    return { ...roughOptions, ...shape.roughOptions };
  }

  return roughOptions;
};

/**
 * Draw a shape on the canvas
 */
export const drawShape = (
  roughCanvas: RoughCanvas,
  context: CanvasRenderingContext2D,
  shape: Shape,
  isInProgress: boolean = false,
  isCollaboratorShape: boolean = false
) => {
  context.save();

  // Set opacity based on shape state
  if (isInProgress) {
    context.globalAlpha = 0.6;
  } else if (isCollaboratorShape) {
    // Collaborator in-progress shapes have distinct style
    context.globalAlpha = 0.3;
    context.setLineDash([5, 5]); // Dashed outline for collaborator shapes
  } else {
    context.globalAlpha = shape.opacity !== undefined ? shape.opacity : 1;
  }

  // Highlight selected shapes
  if (shape.selected) {
    const box = getShapeBoundingBox(shape);
    context.strokeStyle = "#4285f4";
    context.lineWidth = 2;
    context.setLineDash([5, 5]);
    context.strokeRect(box.x - 4, box.y - 4, box.width + 8, box.height + 8);
    context.setLineDash([]);

    // Draw resize handles
    drawSelectionHandles(context, box);
  }

  const options = getRoughOptions(shape);

  // Apply dashed style for collaborator shapes
  if (isCollaboratorShape) {
    options.strokeLineDash = [5, 5];
  }

  switch (shape.tool) {
    case "Freehand":
      drawFreehandPath(context, shape as FreehandShape, isCollaboratorShape);
      break;
    case "Line":
      roughCanvas.line(shape.x1, shape.y1, shape.x2, shape.y2, options);
      break;
    case "Arrow":
      drawArrow(roughCanvas, context, shape as ArrowShape, options);
      break;
    case "Square":
      roughCanvas.rectangle(
        shape.x,
        shape.y,
        shape.width,
        shape.height,
        options
      );
      break;
    case "Circle":
      if (shape.width === shape.height) {
        // Perfect circle
        const radius = shape.width / 2;
        roughCanvas.circle(
          shape.x + radius,
          shape.y + radius,
          shape.width,
          options
        );
      } else {
        // Ellipse
        const width = shape.width;
        const height = shape.height;
        roughCanvas.ellipse(
          shape.x + width / 2,
          shape.y + height / 2,
          width,
          height,
          options
        );
      }
      break;
    case "Diamond":
      drawDiamond(roughCanvas, context, shape as DiamondShape, options);
      break;
    case "Text":
      drawText(context, roughCanvas, shape as TextShape);
      break;
    case "Group":
      // Group shapes don't need to be rendered directly
      // We just draw a bounding box to indicate grouping
      const groupShape = shape as GroupShape;
      context.strokeStyle = "#4285f4";
      context.setLineDash([5, 5]);
      context.strokeRect(shape.x, shape.y, shape.width, shape.height);
      context.setLineDash([]);
      break;
  }

  context.restore();
};

/**
 * Draw freehand path using perfect-freehand
 */
export const drawFreehandPath = (
  context: CanvasRenderingContext2D,
  shape: FreehandShape,
  isCollaboratorShape: boolean = false
) => {
  if (!shape.points.length) return;

  const points: [number, number][] = [];
  for (let i = 0; i < shape.points.length; i += 2) {
    points.push([shape.points[i], shape.points[i + 1]]);
  }

  const stroke = getStroke(points, {
    size: shape.strokeWidth * 2,
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.5,
    easing: (t) => t, // Linear easing for more precise lines
    simulatePressure: false,
  });

  if (stroke.length) {
    context.beginPath();
    context.fillStyle = shape.stroke;

    const [firstX, firstY] = stroke[0];
    context.moveTo(firstX, firstY);

    // Use quadratic curves for smoother lines
    for (let i = 1; i < stroke.length - 1; i++) {
      const [x0, y0] = stroke[i];
      const [x1, y1] = stroke[i + 1];
      const xc = (x0 + x1) / 2;
      const yc = (y0 + y1) / 2;
      context.quadraticCurveTo(x0, y0, xc, yc);
    }

    context.closePath();
    context.fill();
  }
};

/**
 * Draw arrow shape
 */
export const drawArrow = (
  roughCanvas: RoughCanvas,
  context: CanvasRenderingContext2D,
  shape: ArrowShape,
  options: Options
) => {
  // Draw the main line using roughjs
  roughCanvas.line(shape.x1, shape.y1, shape.x2, shape.y2, options);

  // Calculate the arrow head
  const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1);
  const size = shape.arrowSize || 12;

  // Create arrow head points with explicit typing
  const arrowPoints: [number, number][] = [
    [shape.x2, shape.y2],
    [
      shape.x2 - size * Math.cos(angle - Math.PI / 6),
      shape.y2 - size * Math.sin(angle - Math.PI / 6),
    ],
    [
      shape.x2 - size * Math.cos(angle + Math.PI / 6),
      shape.y2 - size * Math.sin(angle + Math.PI / 6),
    ],
  ];

  // Draw the arrowhead with rough style
  // Draw the arrowhead with rough.js lines
  // Make the arrow head longer by increasing the size
  roughCanvas.line(
    shape.x2,
    shape.y2,
    shape.x2 - 1.5 * size * Math.cos(angle - Math.PI / 6),
    shape.y2 - 1.5 * size * Math.sin(angle - Math.PI / 6),
    options
  );
  roughCanvas.line(
    shape.x2,
    shape.y2,
    shape.x2 - 1.5 * size * Math.cos(angle + Math.PI / 6),
    shape.y2 - 1.5 * size * Math.sin(angle + Math.PI / 6),
    options
  );
};

/**
 * Draw diamond shape
 */
export const drawDiamond = (
  roughCanvas: RoughCanvas,
  context: CanvasRenderingContext2D,
  shape: DiamondShape,
  options: Options
) => {
  const centerX = shape.x + shape.width / 2;
  const centerY = shape.y + shape.height / 2;

  // Calculate the four points of the diamond
  const points = [
    [centerX, shape.y], // top point
    [shape.x + shape.width, centerY], // right point
    [centerX, shape.y + shape.height], // bottom point
    [shape.x, centerY], // left point
  ];

  // Draw the diamond using roughjs path
  roughCanvas.polygon(points, options);
};

/**
 * Draw text with stable positioning and professional feel
 */
export const drawText = (
  context: CanvasRenderingContext2D,
  roughCanvas: RoughCanvas,
  shape: TextShape
) => {
  if (!shape.text && !shape.isEditing) return;

  // Set up text styling
  const fontSize = shape.fontSize || 20;
  const fontFamily = shape.fontFamily || "Comic Sans MS";
  context.font = `${fontSize}px ${fontFamily}`;
  context.fillStyle = shape.fill;
  context.textBaseline = "top";

  // Split text into lines and calculate metrics
  const lines = shape.text ? shape.text.split("\n") : [""];
  const lineHeight = fontSize * 1.2;

  // Draw each line with exact positioning
  lines.forEach((line, index) => {
    const y = shape.y + index * lineHeight;
    context.fillText(line, shape.x, y);
  });

  // Draw cursor or text selection when editing
  if (shape.isEditing) {
    const cursorHeight = fontSize * 1.2;
    const now = Date.now();

    // Handle blinking cursor
    if (now % 1000 < 500) {
      // Get cursor position based on text content
      const cursorY = shape.y + (shape.cursorPosition?.line || 0) * lineHeight;

      // Calculate cursor X position based on text width
      const cursorLine = lines[shape.cursorPosition?.line || 0] || "";
      const cursorOffset = shape.cursorPosition?.offset || 0;
      const textBeforeCursor = cursorLine.substring(0, cursorOffset);
      const cursorX = shape.x + context.measureText(textBeforeCursor).width;

      // Draw cursor line
      context.strokeStyle = shape.fill;
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(cursorX, cursorY);
      context.lineTo(cursorX, cursorY + cursorHeight);
      context.stroke();
    }

    // Draw selection background if text is selected
    if (shape.selection) {
      const { start, end } = shape.selection;

      // Only draw if we have a valid selection
      if (start.line !== undefined && end.line !== undefined) {
        context.fillStyle = "rgba(66, 133, 244, 0.3)"; // Light blue

        // Handle single line selection
        if (start.line === end.line) {
          const line = lines[start.line] || "";
          const startX =
            shape.x +
            context.measureText(line.substring(0, start.offset)).width;
          const width = context.measureText(
            line.substring(start.offset, end.offset)
          ).width;

          context.fillRect(
            startX,
            shape.y + start.line * lineHeight,
            width,
            lineHeight
          );
        }
        // Handle multi-line selection
        else {
          // First line (from start to end of line)
          const firstLine = lines[start.line] || "";
          const startX =
            shape.x +
            context.measureText(firstLine.substring(0, start.offset)).width;
          const firstLineWidth = context.measureText(
            firstLine.substring(start.offset)
          ).width;
          context.fillRect(
            startX,
            shape.y + start.line * lineHeight,
            firstLineWidth,
            lineHeight
          );

          // Middle lines (full lines)
          for (let i = start.line + 1; i < end.line; i++) {
            const middleLine = lines[i] || "";
            const middleWidth = context.measureText(middleLine).width;
            context.fillRect(
              shape.x,
              shape.y + i * lineHeight,
              middleWidth,
              lineHeight
            );
          }

          // Last line (from start of line to selection end)
          const lastLine = lines[end.line] || "";
          const lastLineWidth = context.measureText(
            lastLine.substring(0, end.offset)
          ).width;
          context.fillRect(
            shape.x,
            shape.y + end.line * lineHeight,
            lastLineWidth,
            lineHeight
          );
        }

        // Reset fill style for text
        context.fillStyle = shape.fill;
      }
    }
  }
};

/**
 * Draw selection handles
 */
export const drawSelectionHandles = (
  context: CanvasRenderingContext2D,
  box: BoundingBox
) => {
  const handleSize = 8;
  const halfHandle = handleSize / 2;
  const positions = [
    { x: box.x, y: box.y }, // top-left
    { x: box.x + box.width / 2, y: box.y }, // top-center
    { x: box.x + box.width, y: box.y }, // top-right
    { x: box.x + box.width, y: box.y + box.height / 2 }, // middle-right
    { x: box.x + box.width, y: box.y + box.height }, // bottom-right
    { x: box.x + box.width / 2, y: box.y + box.height }, // bottom-center
    { x: box.x, y: box.y + box.height }, // bottom-left
    { x: box.x, y: box.y + box.height / 2 }, // middle-left
  ];

  // Draw handles with white fill and blue border
  positions.forEach((pos) => {
    context.fillStyle = "#ffffff";
    context.strokeStyle = "#4285f4";
    context.lineWidth = 1;
    context.beginPath();
    context.rect(
      pos.x - halfHandle,
      pos.y - halfHandle,
      handleSize,
      handleSize
    );
    context.fill();
    context.stroke();
  });
};

/**
 * Get shape's bounding box
 */
export const getShapeBoundingBox = (shape: Shape): BoundingBox => {
  switch (shape.tool) {
    case "Freehand": {
      if (!shape.points.length) {
        return { x: shape.x, y: shape.y, width: 0, height: 0 };
      }

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (let i = 0; i < shape.points.length; i += 2) {
        const x = shape.points[i];
        const y = shape.points[i + 1];
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }

      return {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      };
    }
    case "Line":
    case "Arrow": {
      const minX = Math.min(shape.x1, shape.x2);
      const minY = Math.min(shape.y1, shape.y2);
      const width = Math.abs(shape.x2 - shape.x1);
      const height = Math.abs(shape.y2 - shape.y1);

      return {
        x: minX,
        y: minY,
        width,
        height,
      };
    }
    case "Square":
    case "Circle":
    case "Diamond": {
      return {
        x: shape.x,
        y: shape.y,
        width: shape.width,
        height: shape.height,
      };
    }
    case "Text": {
      // Create temporary canvas for text measurements
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      if (ctx) {
        const textShape = shape as TextShape;
        const fontSize = textShape.fontSize ?? 20; // Provide default value
        ctx.font = `${fontSize}px ${textShape.fontFamily || "Comic Sans MS"}`;
        const lines = textShape.text.split("\n");
        const lineHeight = fontSize * 1.2;

        let maxWidth = 0;
        lines.forEach((line) => {
          const metrics = ctx.measureText(line);
          maxWidth = Math.max(maxWidth, metrics.width);
        });

        return {
          x: shape.x,
          y: shape.y,
          width: maxWidth,
          height: lineHeight * lines.length,
        };
      }

      // Fallback measurements
      return {
        x: shape.x,
        y: shape.y,
        width: shape.text.length * ((shape.fontSize ?? 20) / 2),
        height: shape.fontSize ?? 20,
      };
    }
  }
};

/**
 * Check if a point is inside a shape or near its edge
 * Returns an object with isInside and isOnEdge flags
 */
export const isPointInShape = (
  x: number,
  y: number,
  shape: Shape
): { isInside: boolean; isOnEdge: boolean } => {
  const box = getShapeBoundingBox(shape);
  const margin = shape.strokeWidth || 2;
  const edgeThreshold = 10; // Distance from edge to consider as "on edge"

  // For lines and arrows, check proximity to the line
  if (shape.tool === "Line" || shape.tool === "Arrow") {
    const isNear = isPointNearLine(
      x,
      y,
      shape.x1,
      shape.y1,
      shape.x2,
      shape.y2,
      margin * 2
    );
    return { isInside: isNear, isOnEdge: isNear };
  }

  // For freehand, check proximity to the stroke
  if (shape.tool === "Freehand") {
    const isNear = isPointNearPath(x, y, shape as FreehandShape, margin * 2);
    return { isInside: isNear, isOnEdge: isNear };
  }

  // Check if point is inside the shape
  const isInside =
    x >= box.x - margin &&
    x <= box.x + box.width + margin &&
    y >= box.y - margin &&
    y <= box.y + box.height + margin;

  // Check if point is near the edge
  const isOnEdge =
    // Check horizontal edges
    ((Math.abs(y - box.y) <= edgeThreshold ||
      Math.abs(y - (box.y + box.height)) <= edgeThreshold) &&
      x >= box.x - edgeThreshold &&
      x <= box.x + box.width + edgeThreshold) ||
    // Check vertical edges
    ((Math.abs(x - box.x) <= edgeThreshold ||
      Math.abs(x - (box.x + box.width)) <= edgeThreshold) &&
      y >= box.y - edgeThreshold &&
      y <= box.y + box.height + edgeThreshold);

  return { isInside, isOnEdge };
};

/**
 * Check if a point is near a line segment
 */
const isPointNearLine = (
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  threshold: number
): boolean => {
  const A = px - x1;
  const B = py - y1;
  const C = x2 - x1;
  const D = y2 - y1;

  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let param = -1;

  if (lenSq !== 0) {
    param = dot / lenSq;
  }

  let xx, yy;

  if (param < 0) {
    xx = x1;
    yy = y1;
  } else if (param > 1) {
    xx = x2;
    yy = y2;
  } else {
    xx = x1 + param * C;
    yy = y1 + param * D;
  }

  const dx = px - xx;
  const dy = py - yy;

  return Math.sqrt(dx * dx + dy * dy) < threshold;
};

/**
 * Check if a point is near a freehand path
 */
const isPointNearPath = (
  x: number,
  y: number,
  shape: FreehandShape,
  threshold: number
): boolean => {
  for (let i = 0; i < shape.points.length - 2; i += 2) {
    if (
      isPointNearLine(
        x,
        y,
        shape.points[i],
        shape.points[i + 1],
        shape.points[i + 2],
        shape.points[i + 3],
        threshold
      )
    ) {
      return true;
    }
  }
  return false;
};

/**
 * Handle eraser action
 */
export const handleEraserAction = (
  x: number,
  y: number,
  shapes: Shape[]
): string[] => {
  const eraserSize = 20; // Set base eraser size to be more precise
  return shapes
    .filter((shape) => {
      // Check if any point of the shape is within the eraser radius
      const box = getShapeBoundingBox(shape);

      // For text shapes, use a more accurate hit test
      if (shape.tool === "Text") {
        return (
          x >= box.x - eraserSize &&
          x <= box.x + box.width + eraserSize &&
          y >= box.y - eraserSize &&
          y <= box.y + box.height + eraserSize
        );
      }

      // For freehand shapes, check each segment with increased sensitivity
      if (shape.tool === "Freehand") {
        const freehand = shape as FreehandShape;
        // If no points, use bounding box
        if (!freehand.points || freehand.points.length < 4) {
          return (
            x >= box.x - eraserSize &&
            x <= box.x + box.width + eraserSize &&
            y >= box.y - eraserSize &&
            y <= box.y + box.height + eraserSize
          );
        }

        // Check each segment with improved hit detection
        for (let i = 0; i < freehand.points.length - 2; i += 2) {
          if (
            isPointNearLine(
              x,
              y,
              freehand.points[i],
              freehand.points[i + 1],
              freehand.points[i + 2],
              freehand.points[i + 3],
              eraserSize
            )
          ) {
            return true;
          }
        }
        return false;
      }

      // For lines and arrows, use more generous threshold
      if (shape.tool === "Line" || shape.tool === "Arrow") {
        return isPointNearLine(
          x,
          y,
          (shape as LineShape).x1,
          (shape as LineShape).y1,
          (shape as LineShape).x2,
          (shape as LineShape).y2,
          eraserSize * 1.5
        );
      }

      // For squares and circles, use a more accurate hit test
      if (shape.tool === "Square" || shape.tool === "Circle") {
        // Expand box slightly to make erasing easier
        const expandedBox = {
          x: box.x - eraserSize / 2,
          y: box.y - eraserSize / 2,
          width: box.width + eraserSize,
          height: box.height + eraserSize,
        };

        return (
          x >= expandedBox.x &&
          x <= expandedBox.x + expandedBox.width &&
          y >= expandedBox.y &&
          y <= expandedBox.y + expandedBox.height
        );
      }

      // Default fallback for any other shape type
      return isPointInShape(x, y, shape).isInside;
    })
    .map((shape) => shape.id);
};

/**
 * Convert our shapes to serializable format for collaboration
 */
export const serializeShapes = (shapes: Shape[]): SerializedShape[] => {
  return shapes
    .map((shape) => {
      let className = "";

      switch (shape.tool) {
        case "Freehand":
        case "Line":
          className = "Line";
          break;
        case "Arrow":
          className = "Arrow";
          break;
        case "Square":
          className = "Rect";
          break;
        case "Circle":
          className = "Circle";
          break;
        case "Diamond":
          className = "Diamond";
          break;
        case "Text":
          className = "Text";
          break;
      }

      return {
        className,
        attrs: { ...shape, tool: undefined },
      };
    })
    .filter((shape) => shape.className !== "");
};

/**
 * Convert serialized shapes back to our Shape type
 */
export const deserializeShapes = (
  serializedShapes: SerializedShape[]
): Shape[] => {
  if (!Array.isArray(serializedShapes)) {
    console.error("Invalid shapes data received:", serializedShapes);
    return [];
  }

  return serializedShapes
    .map((serialized) => {
      try {
        const { className, attrs } = serialized;

        // Map Konva class names back to our tool types
        let toolType: Shape["tool"];
        switch (className) {
          case "Line":
            // Determine if it's a Line or Freehand based on points length
            toolType =
              attrs.points && attrs.points.length === 4 ? "Line" : "Freehand";
            break;
          case "Arrow":
            toolType = "Arrow";
            break;
          case "Rect":
            toolType = "Square";
            break;
          case "Circle":
            toolType = "Circle";
            break;
          case "Diamond":
            toolType = "Diamond";
            break;
          case "Text":
            toolType = "Text";
            break;
          default:
            console.warn(`Unknown shape class: ${className}`);
            return null;
        }

        // Create appropriate shape using our create function
        return createShape(
          toolType,
          attrs,
          attrs.stroke || attrs.fill || "#000000"
        );
      } catch (error) {
        console.error("Error deserializing shape:", error, serialized);
        return null;
      }
    })
    .filter(Boolean) as Shape[]; // Remove any null values
};

/**
 * Intent -> canvas elements.
 *
 * One entry point, `buildFromIntent`, which dispatches to the builder for the
 * kind of thing that was asked for. Every builder produces ordinary elements —
 * the same ones the drawing tools make — so generated content is editable,
 * selectable and undoable like anything else.
 */
import {
  DEFAULT_STYLE,
  type BoundingBox,
  type ElementStyle,
  type Shape,
  type TextShape,
} from "../../types/shapes";
import {
  createElement,
  getElementBounds,
  mutateElement,
} from "../canvas/elements";
import { fitLabelToContainer } from "../canvas/boundText";
import { measureTextWidth } from "../canvas/textMeasure";
import { ACCENT_COLORS, type NodeAccent } from "./graph";
import type { GridSpec } from "./grid";
import type { SceneItem, SceneSpec } from "./scene";
import type { SequenceSpec } from "./sequence";
import { buildSceneFromGraph, type BuiltScene } from "./buildScene";
import type { DetectedGrid } from "./describeScene";
import type { DrawingIntent } from "./intent";

/** Side of the square a normalised scene is scaled into, in world units. */
const SCENE_SIZE = 620;

/** Minimum cell size in a grid, in world units. */
const MIN_CELL = 96;

const CELL_PADDING = 20;

export interface BuildOptions {
  origin: { x: number; y: number };
  style?: ElementStyle;
  existing?: readonly Shape[];
  /**
   * A grid already on the canvas with the same shape as the one being built.
   * When present the marks are written into it, rather than a second board
   * being drawn beside the first — which is what happened every time someone
   * asked to carry on a game.
   */
  anchorGrid?: DetectedGrid | null;
  /**
   * World box a normalised scene should be mapped into. Used to continue an
   * existing drawing in place instead of starting a new one below it.
   */
  anchorBox?: { x: number; y: number; width: number; height: number } | null;
}

const strokeFor = (accent: NodeAccent, fallback: string): string =>
  accent === "none" ? fallback : ACCENT_COLORS[accent].stroke;

/**
 * A text element centred on a point.
 *
 * Centred against the element's own measured box rather than its font size: a
 * line of text is taller than its font size by the line-height factor, so
 * halving the font size left every mark sitting slightly low in its cell.
 */
const centredText = (
  centre: { x: number; y: number },
  text: string,
  fontSize: number,
  stroke: string,
  style: ElementStyle,
): Shape => {
  const element = createElement("Text", { text, fontSize }, stroke, {
    ...style,
    stroke,
    fontSize,
  })!;

  return mutateElement(element, {
    x: centre.x - element.width / 2,
    y: centre.y - element.height / 2,
  });
};

/** Marks of one or two characters read as game pieces and get room to breathe. */
const markFontSize = (
  text: string,
  cellWidth: number,
  cellHeight: number,
  style: ElementStyle,
): number =>
  text.length <= 2
    ? Math.round(Math.min(cellWidth, cellHeight) * 0.5)
    : style.fontSize;

const boundsOf = (elements: readonly Shape[]): BoundingBox => {
  if (elements.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const element of elements) {
    minX = Math.min(minX, element.x);
    minY = Math.min(minY, element.y);
    maxX = Math.max(maxX, element.x + element.width);
    maxY = Math.max(maxY, element.y + element.height);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

/* ------------------------------------------------------------------ *
 * Grid
 * ------------------------------------------------------------------ */

/**
 * Write a new set of marks into a board that is already on the canvas.
 *
 * Only the contents change: the lines stay exactly where they are, marks that
 * are already correct are left alone, and the ones being replaced or cleared are
 * reported for deletion. This is what lets a game be played turn by turn on one
 * board instead of a new board appearing with every move.
 */
const updateExistingGrid = (
  grid: DetectedGrid,
  spec: GridSpec,
  { style, existing }: { style: ElementStyle; existing: readonly Shape[] },
): BuiltScene => {
  const cellCentre = (row: number, column: number) => ({
    x: grid.x + (column + 0.5) * grid.cellWidth,
    y: grid.y + (row + 0.5) * grid.cellHeight,
  });

  const structure = new Set(grid.structureIds);

  /**
   * What is in a cell, if anything.
   *
   * Anything that is not part of the grid's own structure counts. A mark that is
   * not a plain text element was drawn by hand, and gets left alone: an O drawn
   * with the ellipse tool is not Text, so a cell holding one used to read as
   * empty and had a second O written straight on top of it.
   */
  const occupantOf = (
    row: number,
    column: number,
  ): { element: Shape; replaceable: boolean } | null => {
    let found: { element: Shape; replaceable: boolean } | null = null;

    for (const element of existing) {
      if (element.isDeleted || structure.has(element.id)) {
        continue;
      }

      if (element.tool === "Text" && (element as TextShape).containerId) {
        continue;
      }

      const bounds = getElementBounds(element);
      const centreX = bounds.x + bounds.width / 2;
      const centreY = bounds.y + bounds.height / 2;

      const inColumn =
        Math.floor((centreX - grid.x) / grid.cellWidth) === column;
      const inRow = Math.floor((centreY - grid.y) / grid.cellHeight) === row;

      if (!inRow || !inColumn) {
        continue;
      }

      const replaceable =
        element.tool === "Text" && Boolean((element as TextShape).text.trim());

      // A hand-drawn mark wins: it is the one that must survive.
      if (!replaceable) {
        return { element, replaceable: false };
      }

      found = found ?? { element, replaceable: true };
    }

    return found;
  };

  const elements: Shape[] = [];
  const removedIds: string[] = [];

  for (let row = 0; row < grid.rows; row += 1) {
    for (let column = 0; column < grid.columns; column += 1) {
      const wanted =
        spec.cells.find((cell) => cell.row === row && cell.column === column)
          ?.text ?? "";
      const current = occupantOf(row, column);

      // Somebody drew in this cell. Whatever the reply says about it, it stands.
      if (current && !current.replaceable) {
        continue;
      }

      const currentText =
        current && current.element.tool === "Text"
          ? (current.element as TextShape).text.trim()
          : "";

      if (current && currentText === wanted.trim()) {
        continue;
      }

      if (current) {
        removedIds.push(current.element.id);
      }

      if (!wanted) {
        continue;
      }

      const cell = spec.cells.find(
        (candidate) => candidate.row === row && candidate.column === column,
      );

      elements.push(
        centredText(
          cellCentre(row, column),
          wanted,
          markFontSize(wanted, grid.cellWidth, grid.cellHeight, style),
          strokeFor(cell?.accent ?? "none", style.stroke),
          style,
        ),
      );
    }
  }

  return {
    elements,
    bounds: {
      x: grid.x,
      y: grid.y,
      width: grid.cellWidth * grid.columns,
      height: grid.cellHeight * grid.rows,
    },
    removedIds,
  };
};

export const buildGrid = (
  spec: GridSpec,
  { origin, style = DEFAULT_STYLE, existing = [], anchorGrid }: BuildOptions,
): BuiltScene => {
  const { rows, columns, style: gridStyle, headerRow, cells } = spec;

  // Carrying on with a board already on the canvas: reuse its geometry and only
  // change what is inside the cells.
  const anchored =
    anchorGrid && anchorGrid.rows === rows && anchorGrid.columns === columns
      ? anchorGrid
      : null;

  if (anchored) {
    return updateExistingGrid(anchored, spec, { style, existing });
  }

  // Cells are square unless a label needs more room, so a board stays a board.
  const widest = cells.reduce(
    (max, cell) =>
      Math.max(
        max,
        cell.text
          ? measureTextWidth(cell.text, style.fontSize, style.fontFamily)
          : 0,
      ),
    0,
  );

  const cellWidth = Math.max(MIN_CELL, Math.ceil(widest) + CELL_PADDING * 2);
  const cellHeight = MIN_CELL;

  const width = cellWidth * columns;
  const height = cellHeight * rows;

  const elements: Shape[] = [];

  const cellAt = (row: number, column: number) =>
    cells.find((cell) => cell.row === row && cell.column === column);

  if (gridStyle === "table") {
    // Every cell is its own rectangle, so the table has an outer border and
    // each cell's label can be edited in place.
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const cell = cellAt(row, column);
        const isHeader = headerRow && row === 0;
        const accent = cell?.accent ?? "none";

        const container = createElement(
          "Square",
          {
            x: origin.x + column * cellWidth,
            y: origin.y + row * cellHeight,
            width: cellWidth,
            height: cellHeight,
          },
          style.stroke,
          {
            ...style,
            fill:
              accent !== "none"
                ? ACCENT_COLORS[accent].fill
                : isHeader
                  ? "#f1f3f5"
                  : "transparent",
            fillStyle: "solid",
          },
        )!;

        if (!cell?.text) {
          elements.push(container);
          continue;
        }

        const label = createElement(
          "Text",
          { text: cell.text, containerId: container.id },
          strokeFor(accent, style.stroke),
          { ...style, stroke: strokeFor(accent, style.stroke) },
        ) as TextShape;

        const fitted = fitLabelToContainer(label, container);

        elements.push(
          mutateElement(fitted.container, {
            boundElements: [{ id: fitted.label.id, type: "text" }],
          }),
          fitted.label,
        );
      }
    }
  } else {
    // A board is just the separators — no box around the outside.
    for (let column = 1; column < columns; column += 1) {
      const x = origin.x + column * cellWidth;
      elements.push(
        createElement(
          "Line",
          { x1: x, y1: origin.y, x2: x, y2: origin.y + height },
          style.stroke,
          style,
        )!,
      );
    }

    for (let row = 1; row < rows; row += 1) {
      const y = origin.y + row * cellHeight;
      elements.push(
        createElement(
          "Line",
          { x1: origin.x, y1: y, x2: origin.x + width, y2: y },
          style.stroke,
          style,
        )!,
      );
    }

    // Marks sit centred in their cell as free text.
    for (const cell of cells) {
      if (!cell.text) {
        continue;
      }

      elements.push(
        centredText(
          {
            x: origin.x + (cell.column + 0.5) * cellWidth,
            y: origin.y + (cell.row + 0.5) * cellHeight,
          },
          cell.text,
          markFontSize(cell.text, cellWidth, cellHeight, style),
          strokeFor(cell.accent, style.stroke),
          style,
        ),
      );
    }
  }

  return {
    elements,
    bounds: { x: origin.x, y: origin.y, width, height },
    removedIds: [],
  };
};

/* ------------------------------------------------------------------ *
 * Scene
 * ------------------------------------------------------------------ */

const SCENE_TOOLS = {
  rectangle: "Square",
  ellipse: "Circle",
  diamond: "Diamond",
  triangle: "Triangle",
  line: "Line",
  arrow: "Arrow",
  text: "Text",
} as const;

export const buildScene = (
  spec: SceneSpec,
  { origin, style = DEFAULT_STYLE, anchorBox }: BuildOptions,
): BuiltScene => {
  // Continuing an existing drawing means mapping the normalised space onto the
  // area that drawing already occupies, so additions land where they belong
  // rather than as a separate picture underneath it.
  const frame = anchorBox ?? {
    x: origin.x,
    y: origin.y,
    width: SCENE_SIZE,
    height: SCENE_SIZE,
  };

  const toWorldX = (value: number) => frame.x + (value / 100) * frame.width;
  const toWorldY = (value: number) => frame.y + (value / 100) * frame.height;
  // Sizes use the smaller axis, so shapes are not stretched by an oblong frame.
  const toWorldSize = (value: number) =>
    (value / 100) * Math.min(frame.width, frame.height);

  const elements: Shape[] = [];

  const place = (item: SceneItem): Shape | null => {
    const stroke = strokeFor(item.accent, style.stroke);
    const shared: Partial<ElementStyle> = {
      ...style,
      stroke,
      fill:
        item.filled && item.accent !== "none"
          ? ACCENT_COLORS[item.accent].fill
          : "transparent",
      fillStyle: "solid",
    };

    const x = toWorldX(item.x);
    const y = toWorldY(item.y);

    if (item.shape === "line" || item.shape === "arrow") {
      const connector = createElement(
        SCENE_TOOLS[item.shape],
        {
          x1: x,
          y1: y,
          x2: toWorldX(item.x2),
          y2: toWorldY(item.y2),
          // Straight, because a scene's lines are placed deliberately and should
          // land exactly where they were put.
          edgeStyle: "straight",
        },
        stroke,
        { ...shared, edgeStyle: "straight" },
      )!;

      /*
       * A label on an arrow is how a figure names a force or a quantity, and it
       * used to be dropped on the floor. It sits beside the middle of the line,
       * offset along the perpendicular so it never lies on top of the stroke.
       */
      if (item.text) {
        const endX = toWorldX(item.x2);
        const endY = toWorldY(item.y2);
        const dx = endX - x;
        const dy = endY - y;
        const length = Math.hypot(dx, dy) || 1;
        const offset = 14;

        elements.push(
          centredText(
            {
              x: (x + endX) / 2 - (dy / length) * offset,
              y: (y + endY) / 2 + (dx / length) * offset,
            },
            item.text,
            Math.max(14, Math.round(style.fontSize * 0.8)),
            stroke,
            style,
          ),
        );
      }

      return connector;
    }

    if (item.shape === "text") {
      // Height drives the font size, which is how the model expresses emphasis.
      const fontSize = Math.max(
        12,
        Math.min(96, Math.round(toWorldSize(item.height))),
      );

      return createElement(
        "Text",
        {
          x,
          y,
          text: item.text,
          fontSize,
          angle: (item.rotation * Math.PI) / 180,
        },
        stroke,
        { ...shared, fontSize },
      );
    }

    const container = createElement(
      SCENE_TOOLS[item.shape],
      {
        x,
        y,
        width: (item.width / 100) * frame.width,
        height: (item.height / 100) * frame.height,
        angle: (item.rotation * Math.PI) / 180,
      },
      stroke,
      shared,
    )!;

    if (!item.text) {
      return container;
    }

    // A shape with text gets a proper bound label, so it stays centred, sized to
    // fit rather than spilling out of a small shape.
    const label = createElement(
      "Text",
      { text: item.text, containerId: container.id },
      stroke,
      shared,
    ) as TextShape;

    const fitted = fitLabelToContainer(label, container);

    elements.push(
      mutateElement(fitted.container, {
        boundElements: [{ id: fitted.label.id, type: "text" }],
      }),
    );

    return fitted.label;
  };

  for (const item of spec.items) {
    const element = place(item);
    if (element) {
      elements.push(element);
    }
  }

  return {
    elements,
    bounds: boundsOf(elements),
    removedIds: [],
  };
};

/* ------------------------------------------------------------------ *
 * Sequence
 * ------------------------------------------------------------------ */

/** Vertical distance between one message and the next. */
const MESSAGE_STEP = 62;

/** Gap between participant lifelines. */
const LIFELINE_GAP = 56;

const HEADER_HEIGHT = 52;
const MIN_HEADER_WIDTH = 108;

/** How far a self-call loops out to the right. */
const SELF_CALL_REACH = 44;

export const buildSequence = (
  spec: SequenceSpec,
  { origin, style = DEFAULT_STYLE }: BuildOptions,
): BuiltScene => {
  const { participants, messages } = spec;

  // Every header is the same width, so the lifelines sit on an even pitch.
  const headerWidth = Math.max(
    MIN_HEADER_WIDTH,
    ...participants.map(
      (participant) =>
        Math.ceil(
          measureTextWidth(participant.label, style.fontSize, style.fontFamily),
        ) + CELL_PADDING * 2,
    ),
  );

  const pitch = headerWidth + LIFELINE_GAP;
  const sections = messages.filter((message) => message.section).length;
  const bodyHeight = (messages.length + sections) * MESSAGE_STEP + MESSAGE_STEP;

  const elements: Shape[] = [];

  /** Centre x of a participant's lifeline. */
  const lifelineX = new Map<string, number>();

  participants.forEach((participant, index) => {
    const x = origin.x + index * pitch;
    const accent = ACCENT_COLORS[participant.accent];

    const header = createElement(
      "Square",
      { x, y: origin.y, width: headerWidth, height: HEADER_HEIGHT },
      accent.stroke,
      {
        ...style,
        stroke: accent.stroke,
        fill: participant.accent === "none" ? "#f1f3f5" : accent.fill,
        fillStyle: "solid",
      },
    )!;

    const label = createElement(
      "Text",
      { text: participant.label, containerId: header.id },
      accent.stroke,
      { ...style, stroke: accent.stroke },
    ) as TextShape;

    const fitted = fitLabelToContainer(label, header);

    elements.push(
      mutateElement(fitted.container, {
        boundElements: [{ id: fitted.label.id, type: "text" }],
      }),
      fitted.label,
    );

    const centre = x + headerWidth / 2;
    lifelineX.set(participant.id, centre);

    // The lifeline: dashed, so it reads as time passing rather than a connector.
    elements.push(
      createElement(
        "Line",
        {
          x1: centre,
          y1: origin.y + HEADER_HEIGHT,
          x2: centre,
          y2: origin.y + HEADER_HEIGHT + bodyHeight,
          strokeStyle: "dashed",
        },
        style.stroke,
        { ...style, strokeStyle: "dashed" },
      )!,
    );
  });

  const leftEdge = origin.x;
  const rightEdge = origin.x + (participants.length - 1) * pitch + headerWidth;

  let row = 0;

  for (const message of messages) {
    if (message.section) {
      // A section divider spans the diagram and names the phase below it.
      const y = origin.y + HEADER_HEIGHT + (row + 0.5) * MESSAGE_STEP;

      elements.push(
        centredText(
          { x: (leftEdge + rightEdge) / 2, y },
          message.section,
          style.fontSize,
          "#868e96",
          style,
        ),
      );

      row += 1;
    }

    const y = origin.y + HEADER_HEIGHT + (row + 1) * MESSAGE_STEP;
    const from = lifelineX.get(message.from)!;
    const to = lifelineX.get(message.to)!;
    const dashed = message.kind === "return";

    const arrowStyle = {
      ...style,
      strokeStyle: dashed ? ("dashed" as const) : ("solid" as const),
      edgeStyle: "straight" as const,
    };

    if (message.kind === "self") {
      // A loop out to the right and back, so it does not vanish into the line.
      elements.push(
        createElement(
          "Arrow",
          {
            x1: from,
            y1: y,
            x2: from,
            y2: y + MESSAGE_STEP * 0.45,
            midPoints: [
              from + SELF_CALL_REACH,
              y,
              from + SELF_CALL_REACH,
              y + MESSAGE_STEP * 0.45,
            ],
            strokeStyle: arrowStyle.strokeStyle,
            edgeStyle: "straight",
          },
          style.stroke,
          arrowStyle,
        )!,
      );

      if (message.label) {
        const text = createElement(
          "Text",
          { text: message.label, fontSize: style.fontSize },
          style.stroke,
          style,
        )!;

        elements.push(
          mutateElement(text, {
            x: from + SELF_CALL_REACH + 10,
            y: y + MESSAGE_STEP * 0.1,
          }),
        );
      }
    } else {
      elements.push(
        createElement(
          "Arrow",
          {
            x1: from,
            y1: y,
            x2: to,
            y2: y,
            strokeStyle: arrowStyle.strokeStyle,
            edgeStyle: "straight",
          },
          style.stroke,
          arrowStyle,
        )!,
      );

      if (message.label) {
        // Label sits above its own arrow, centred on the span it covers.
        elements.push(
          centredText(
            { x: (from + to) / 2, y: y - style.fontSize },
            message.label,
            style.fontSize,
            style.stroke,
            style,
          ),
        );
      }
    }

    row += 1;
  }

  return {
    elements,
    bounds: {
      x: leftEdge,
      y: origin.y,
      width: rightEdge - leftEdge,
      height: HEADER_HEIGHT + bodyHeight,
    },
    removedIds: [],
  };
};

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

export const buildFromIntent = (
  intent: DrawingIntent,
  options: BuildOptions,
): BuiltScene => {
  switch (intent.kind) {
    case "grid":
      return buildGrid(intent.grid, options);
    case "sequence":
      return buildSequence(intent.sequence, options);
    case "scene":
      return buildScene(intent.scene, options);
    case "diagram":
    default:
      return buildSceneFromGraph(intent.diagram, {
        ...options,
        existing: intent.diagram.replaceCanvas ? [] : options.existing,
      });
  }
};

export type { BuiltScene };

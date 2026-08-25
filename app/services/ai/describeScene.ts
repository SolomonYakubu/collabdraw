/**
 * Canvas -> a description the model can reason about and build on.
 *
 * This is what makes "carry on with what I drew" work, and its first version did
 * not: it only reported *labelled container shapes* as nodes and bound arrows as
 * edges, so a tic-tac-toe board (lines plus loose text) or a half-finished
 * sketch (plain boxes plus loose text) both collapsed into an "N other
 * elements" count. The model was effectively told the canvas was empty, so it
 * started again from scratch every time.
 *
 * Now the canvas is described three ways at once, and the model uses whichever
 * fits: as a graph, as a detected grid, and as a list of items in the same
 * normalised 0-100 frame it uses for its own output.
 */
import { isLinearShape, type Shape, type TextShape } from "../../types/shapes";
import { getBoundLabel } from "../canvas/boundText";
import { getElementBounds, getRotatedBounds } from "../canvas/elements";
import type { NodeShape } from "./graph";
import type { GridStyle } from "./grid";
import type { SystemComponentType } from "./system";

export interface SceneNode {
  id: string;
  label: string;
  shape: NodeShape;
}

/**
 * Best-effort guess of what kind of system component a labelled node is, from
 * its own name. This is what lets a follow-up like "add a cache between the API
 * and the database" be answered with a typed node bound to the existing ones:
 * the model sees "Postgres" and knows it is already a database.
 */
export const inferComponentType = (
  label: string,
): SystemComponentType | null => {
  const text = label.toLowerCase();

  /** First match wins, so order encodes priority — "cache cluster" is a cache. */
  const patterns: Array<[RegExp, SystemComponentType]> = [
    [/\b(load[- ]?balancer|\blb\b|balancer)\b/, "load-balancer"],
    [
      /\b(database|db|postgres(ql)?|mysql|mongo(db)?|dynamo(db)?)\b/,
      "database",
    ],
    [/\b(cache|redis|memcached)\b/, "cache"],
    [/\b(queue|kafka|rabbitmq|sqs|pubsub|pub\/sub|broker)\b/, "queue"],
    [/\b(s3|bucket|blob storage|object storage|storage)\b/, "storage"],
    [/\b(cdn|cloudfront)\b/, "cdn"],
    [/\b(firewall|waf)\b/, "firewall"],
    [/\b(gateway|proxy|router|ingress|envoy|nginx)\b/, "gateway"],
    [
      /\b(client|browser|user|mobile app|web app|frontend|front-end)\b/,
      "client",
    ],
    [/\b(third[- ]party|external|stripe|payment provider)\b/, "external"],
  ];

  for (const [pattern, type] of patterns) {
    if (pattern.test(text)) {
      return type;
    }
  }

  return null;
};

export interface SceneEdge {
  from: string;
  to: string;
}

/** One element, in the normalised frame of the canvas's own content. */
export interface SceneItemSummary {
  shape: string;
  x: number;
  y: number;
  width: number;
  height: number;
  x2?: number;
  y2?: number;
  text?: string;
  /** Clockwise degrees, omitted when the element is upright. */
  rotation?: number;
}

/**
 * A grid found on the canvas. Carries world geometry as well as counts, so new
 * marks can be written into the *existing* board instead of drawing another one.
 */
/**
 * What occupies a cell.
 *
 * `text` is replaceable — it was typed, or written by a previous reply. `drawn`
 * is a mark somebody made with the drawing tools, and must never be overwritten:
 * an O drawn with the ellipse tool is not a Text element, so a cell holding one
 * used to read as empty and got a second O written on top of it.
 */
export type CellSource = "text" | "drawn";

export interface DetectedCell {
  row: number;
  column: number;
  text: string;
  source: CellSource;
}

export interface DetectedGrid {
  rows: number;
  columns: number;
  style: GridStyle;
  x: number;
  y: number;
  cellWidth: number;
  cellHeight: number;
  cells: DetectedCell[];
  /** Ids of the lines or cell rectangles that form the grid itself. */
  structureIds: string[];
}

export interface SceneSummary {
  nodes: SceneNode[];
  edges: SceneEdge[];
  items: SceneItemSummary[];
  grid: DetectedGrid | null;
  /** World-space box containing everything, or null for an empty canvas. */
  bounds: { x: number; y: number; width: number; height: number } | null;
  otherCount: number;
}

export const EMPTY_SCENE: SceneSummary = {
  nodes: [],
  edges: [],
  items: [],
  grid: null,
  bounds: null,
  otherCount: 0,
};

const SHAPE_NAMES: Record<string, NodeShape> = {
  Square: "rectangle",
  Circle: "ellipse",
  Diamond: "diamond",
};

const ITEM_NAMES: Record<string, string> = {
  Square: "rectangle",
  Circle: "ellipse",
  Diamond: "diamond",
  Triangle: "triangle",
  Line: "line",
  Arrow: "arrow",
  Text: "text",
  Freehand: "freehand",
};

/** Keep the prompt bounded on a busy canvas. */
const MAX_ITEMS = 60;

/** Tolerance for calling two coordinates equal, in world units. */
const EPSILON = 2;

/* ------------------------------------------------------------------ *
 * Grid detection
 * ------------------------------------------------------------------ */

const isEvenlySpaced = (values: number[], expected: number): boolean =>
  values.every(
    (value, index) =>
      Math.abs(value - (values[0] + index * expected)) <= EPSILON,
  );

/**
 * Look for a board: evenly spaced axis-aligned separator lines that all span the
 * same extent. This is what a hand-drawn or generated tic-tac-toe grid is.
 */
const detectBoard = (elements: readonly Shape[]): DetectedGrid | null => {
  const verticals: Array<{ id: string; x: number; from: number; to: number }> =
    [];
  const horizontals: Array<{
    id: string;
    y: number;
    from: number;
    to: number;
  }> = [];

  for (const element of elements) {
    if (element.isDeleted || element.tool !== "Line") {
      continue;
    }

    const { x1, y1, x2, y2 } = element;

    if (Math.abs(x1 - x2) <= EPSILON && Math.abs(y1 - y2) > EPSILON) {
      verticals.push({
        id: element.id,
        x: (x1 + x2) / 2,
        from: Math.min(y1, y2),
        to: Math.max(y1, y2),
      });
    } else if (Math.abs(y1 - y2) <= EPSILON && Math.abs(x1 - x2) > EPSILON) {
      horizontals.push({
        id: element.id,
        y: (y1 + y2) / 2,
        from: Math.min(x1, x2),
        to: Math.max(x1, x2),
      });
    }
  }

  if (verticals.length === 0 || horizontals.length === 0) {
    return null;
  }

  // Separators of a grid share their span; anything else is not part of it.
  const sameSpan = <T extends { from: number; to: number }>(list: T[]): T[] => {
    const first = list[0];
    return list.filter(
      (item) =>
        Math.abs(item.from - first.from) <= EPSILON * 2 &&
        Math.abs(item.to - first.to) <= EPSILON * 2,
    );
  };

  verticals.sort((a, b) => a.x - b.x);
  horizontals.sort((a, b) => a.y - b.y);

  const columnLines = sameSpan(verticals);
  const rowLines = sameSpan(horizontals);

  const columns = columnLines.length + 1;
  const rows = rowLines.length + 1;

  if (rows * columns < 2) {
    return null;
  }

  // The separators bound the board on one axis and span it on the other.
  const left = Math.min(...rowLines.map((line) => line.from));
  const right = Math.max(...rowLines.map((line) => line.to));
  const top = Math.min(...columnLines.map((line) => line.from));
  const bottom = Math.max(...columnLines.map((line) => line.to));

  const width = right - left;
  const height = bottom - top;

  if (!(width > 0) || !(height > 0)) {
    return null;
  }

  const cellWidth = width / columns;
  const cellHeight = height / rows;

  // Reject anything that is merely a few crossing lines.
  if (
    !isEvenlySpaced(
      columnLines.map((line) => line.x),
      cellWidth,
    ) ||
    !isEvenlySpaced(
      rowLines.map((line) => line.y),
      cellHeight,
    ) ||
    Math.abs(columnLines[0].x - (left + cellWidth)) > EPSILON * 2 ||
    Math.abs(rowLines[0].y - (top + cellHeight)) > EPSILON * 2
  ) {
    return null;
  }

  return {
    rows,
    columns,
    style: "board",
    x: left,
    y: top,
    cellWidth,
    cellHeight,
    cells: [],
    structureIds: [...columnLines, ...rowLines].map((line) => line.id),
  };
};

/** Look for a table: same-sized rectangles arranged on a lattice. */
const detectTable = (elements: readonly Shape[]): DetectedGrid | null => {
  const boxes = elements.filter(
    (element) =>
      !element.isDeleted && element.tool === "Square" && element.width > 8,
  );

  if (boxes.length < 4) {
    return null;
  }

  const [first] = boxes;
  const sameSize = boxes.filter(
    (box) =>
      Math.abs(box.width - first.width) <= EPSILON &&
      Math.abs(box.height - first.height) <= EPSILON,
  );

  if (sameSize.length < 4) {
    return null;
  }

  const xs = [...new Set(sameSize.map((box) => Math.round(box.x)))].sort(
    (a, b) => a - b,
  );
  const ys = [...new Set(sameSize.map((box) => Math.round(box.y)))].sort(
    (a, b) => a - b,
  );

  if (xs.length < 2 || ys.length < 2) {
    return null;
  }

  // Every lattice position must be occupied for this to be a table.
  if (sameSize.length !== xs.length * ys.length) {
    return null;
  }

  if (!isEvenlySpaced(xs, first.width) || !isEvenlySpaced(ys, first.height)) {
    return null;
  }

  return {
    rows: ys.length,
    columns: xs.length,
    style: "table",
    x: xs[0],
    y: ys[0],
    cellWidth: first.width,
    cellHeight: first.height,
    cells: [],
    structureIds: sameSize.map((box) => box.id),
  };
};

/**
 * Fill a detected grid's cells from whatever is sitting inside them.
 *
 * Anything that is not part of the grid's own structure counts as a mark. A
 * circle in a cell is read as an O, since that is what one means on a board;
 * anything else unrecognised is reported as occupied without guessing at it.
 */
const readGridCells = (
  grid: DetectedGrid,
  elements: readonly Shape[],
): DetectedGrid => {
  const structure = new Set(grid.structureIds);
  const cells: DetectedCell[] = [];

  const describeMark = (
    element: Shape,
  ): { text: string; source: CellSource } | null => {
    if (element.tool === "Text") {
      const label = element as TextShape;
      // A bound label belongs to its container, not to the cell.
      if (label.containerId || !label.text.trim()) {
        return null;
      }
      return { text: label.text.trim(), source: "text" };
    }

    if (element.tool === "Circle") {
      return { text: "O", source: "drawn" };
    }

    // A cross drawn by hand, a scribble, a shape: occupied, contents unknown.
    return { text: "?", source: "drawn" };
  };

  for (const element of elements) {
    if (element.isDeleted || structure.has(element.id)) {
      continue;
    }

    const mark = describeMark(element);
    if (!mark) {
      continue;
    }

    const bounds = getRotatedBounds(element);
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;

    const column = Math.floor((centerX - grid.x) / grid.cellWidth);
    const row = Math.floor((centerY - grid.y) / grid.cellHeight);

    if (row < 0 || column < 0 || row >= grid.rows || column >= grid.columns) {
      continue;
    }

    const existing = cells.find(
      (cell) => cell.row === row && cell.column === column,
    );

    if (!existing) {
      cells.push({ row, column, ...mark });
      continue;
    }

    // A hand-drawn mark in a cell outranks a text one: it is the thing that
    // must not be touched.
    if (existing.source === "text" && mark.source === "drawn") {
      existing.text = mark.text;
      existing.source = "drawn";
    }
  }

  return { ...grid, cells };
};

export const detectGrid = (elements: readonly Shape[]): DetectedGrid | null => {
  const grid = detectBoard(elements) ?? detectTable(elements);
  return grid ? readGridCells(grid, elements) : null;
};

/* ------------------------------------------------------------------ *
 * Description
 * ------------------------------------------------------------------ */

export const describeScene = (elements: readonly Shape[]): SceneSummary => {
  const live = elements.filter((element) => !element.isDeleted);

  if (live.length === 0) {
    return EMPTY_SCENE;
  }

  /* --- Graph view: labelled containers and the arrows between them --- */
  const nodes: SceneNode[] = [];
  const labelById = new Map<string, string>();

  for (const element of live) {
    const shape = SHAPE_NAMES[element.tool];
    if (!shape) {
      continue;
    }

    const label = getBoundLabel(element, live)?.text.trim() ?? "";
    if (!label) {
      continue;
    }

    labelById.set(element.id, label);
    nodes.push({ id: label, label, shape });
  }

  const edges: SceneEdge[] = [];
  const seenEdges = new Set<string>();

  for (const element of live) {
    if (!isLinearShape(element)) {
      continue;
    }

    const from = element.startBinding
      ? labelById.get(element.startBinding.elementId)
      : undefined;
    const to = element.endBinding
      ? labelById.get(element.endBinding.elementId)
      : undefined;

    if (!from || !to || from === to) {
      continue;
    }

    const signature = `${from}->${to}`;
    if (!seenEdges.has(signature)) {
      seenEdges.add(signature);
      edges.push({ from, to });
    }
  }

  /* --- Overall extent, which the normalised frame is measured against --- */
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const element of live) {
    const box = getElementBounds(element);
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }

  const bounds = {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };

  const toNormX = (value: number) =>
    Math.round(((value - bounds.x) / bounds.width) * 100);
  const toNormY = (value: number) =>
    Math.round(((value - bounds.y) / bounds.height) * 100);

  /* --- Item view: everything, in the same vocabulary the model outputs --- */
  const items: SceneItemSummary[] = [];
  let otherCount = 0;

  for (const element of live) {
    const shape = ITEM_NAMES[element.tool];

    if (!shape) {
      otherCount += 1;
      continue;
    }

    if (items.length >= MAX_ITEMS) {
      otherCount += 1;
      continue;
    }

    const box = getElementBounds(element);
    const summary: SceneItemSummary = {
      shape,
      x: toNormX(box.x),
      y: toNormY(box.y),
      width: Math.round((box.width / bounds.width) * 100),
      height: Math.round((box.height / bounds.height) * 100),
    };

    if (isLinearShape(element)) {
      summary.x = toNormX(element.x1);
      summary.y = toNormY(element.y1);
      summary.x2 = toNormX(element.x2);
      summary.y2 = toNormY(element.y2);
      summary.width = 0;
      summary.height = 0;
    }

    if (element.tool === "Text") {
      summary.text = (element as TextShape).text.trim();
    } else {
      const label = getBoundLabel(element, live)?.text.trim();
      if (label) {
        summary.text = label;
      }
    }

    if (element.angle !== 0) {
      summary.rotation = Math.round((element.angle * 180) / Math.PI);
    }

    items.push(summary);
  }

  return {
    nodes,
    edges,
    items,
    grid: detectGrid(live),
    bounds,
    otherCount,
  };
};

/**
 * A compact text rendering of the canvas for the prompt. Deliberately shows all
 * three views: the model picks whichever matches what it is being asked to do.
 */
/**
 * A compact text rendering of the canvas for the prompt.
 *
 * All three views are shown — grid, graph, and the item list — because the model
 * picks whichever matches what it is being asked to do. The item list used to be
 * suppressed whenever a grid was detected, which hid everything else on the
 * canvas from anything that was not about the board.
 */
export const formatSceneForPrompt = (summary: SceneSummary): string => {
  if (summary.items.length === 0 && summary.nodes.length === 0) {
    return "The canvas is empty. Draw wherever you like.";
  }

  const lines: string[] = [];

  if (summary.bounds) {
    const { width, height } = summary.bounds;
    lines.push(
      `The existing drawing occupies a region ${Math.round(width)} by ${Math.round(
        height,
      )} units. Coordinates below are 0-100 across that region, the same scale you use for a scene.`,
    );
  }

  if (summary.grid) {
    const { rows, columns, style, cells } = summary.grid;
    lines.push(
      "",
      `There is a ${rows}x${columns} ${style} on the canvas.`,
      cells.length > 0
        ? `Its filled cells (row, column, contents): ${cells
            .map(
              (cell) =>
                `(${cell.row}, ${cell.column}, "${cell.text}"${
                  cell.source === "drawn" ? ", hand-drawn" : ""
                })`,
            )
            .join(", ")}`
        : "All of its cells are empty.",
      `To change it, reply with kind "grid", placement "add", the SAME ${rows} rows and ${columns} columns, and the FULL list of cells you want it to end up with, including the ones already there. It is updated in place.`,
      cells.some((cell) => cell.source === "drawn")
        ? "Cells marked hand-drawn were drawn with the drawing tools. List them so the board stays complete, but they are left exactly as they are — never redrawn."
        : "",
    );
  }

  if (summary.nodes.length > 0) {
    lines.push(
      "",
      "Diagram nodes present:",
      ...summary.nodes.map((node) => {
        const componentType = inferComponentType(node.label);
        return `- "${node.label}" (${node.shape}${
          componentType ? `, reads as a ${componentType}` : ""
        })`;
      }),
      summary.edges.length > 0
        ? `Connections: ${summary.edges
            .map((edge) => `"${edge.from}" -> "${edge.to}"`)
            .join(", ")}`
        : "They are not connected to each other yet.",
    );
  }

  if (summary.items.length > 0) {
    lines.push(
      "",
      `Everything on the canvas (${summary.items.length} element${
        summary.items.length === 1 ? "" : "s"
      }):`,
      ...summary.items.map((item) => {
        const where =
          item.x2 !== undefined
            ? `(${item.x},${item.y}) to (${item.x2},${item.y2})`
            : `at (${item.x},${item.y}) size ${item.width}x${item.height}`;
        const turned = item.rotation ? `, rotated ${item.rotation}°` : "";
        const text = item.text ? ` labelled "${item.text}"` : "";
        return `- ${item.shape} ${where}${turned}${text}`;
      }),
    );
  }

  if (summary.otherCount > 0) {
    lines.push(`Plus ${summary.otherCount} further element(s).`);
  }

  lines.push(
    "",
    'This region is already occupied. Use placement "add" only to extend or finish THIS drawing; use "replace" if your output supersedes it, or "beside" to put a separate drawing next to it.',
  );

  return lines.join("\n");
};

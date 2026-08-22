/**
 * Graph + layout -> canvas elements.
 *
 * Edges become real bound arrows, so AI output behaves exactly like something
 * drawn by hand: drag a node and its connectors follow, delete it and they
 * release. Node labels become container-bound text, so they stay centred.
 *
 * The old endpoint emitted loose lines whose coordinates happened to sit near a
 * box, which is why AI diagrams fell apart the moment anything was moved.
 */
import {
  DEFAULT_STYLE,
  isLinearShape,
  type ElementStyle,
  type Shape,
  type TextShape,
} from "../../types/shapes";
import { createElement, mutateElement } from "../canvas/elements";
import { applyBindings, createBinding } from "../canvas/bindings";
import {
  fitLabelToContainer,
  getRequiredContainerSize,
} from "../canvas/boundText";
import {
  getLineHeight,
  measureTextWidth,
  wrapText,
} from "../canvas/textMeasure";
import { ACCENT_COLORS, type DiagramGraph, type NodeShape } from "./graph";
import { layoutGraph, type LaidOutNode } from "./layout";

const SHAPE_TOOLS: Record<NodeShape, "Square" | "Circle" | "Diamond"> = {
  rectangle: "Square",
  ellipse: "Circle",
  diamond: "Diamond",
};

export interface BuildSceneOptions {
  /** Where to put the diagram's top-left corner, in world coordinates. */
  origin: { x: number; y: number };
  /** Base style; the accent colours override stroke and fill per node. */
  style?: ElementStyle;
  /** Elements already on the canvas, so edges can bind to existing nodes. */
  existing?: readonly Shape[];
}

/** Font used for node labels — a touch smaller than free text. */
const LABEL_FONT_SIZE = 16;

/**
 * Widest a label is allowed to run before it wraps. Without a cap, one long
 * label stretches its whole layer and the diagram sprawls sideways.
 */
const MAX_LABEL_WIDTH = 168;

/** Breathing room between a shape's outline and its label's box. */
const NODE_PADDING = 14;

const MIN_NODE_WIDTH = 120;
const MIN_NODE_HEIGHT = 56;

/**
 * The box a node needs to hold its label.
 *
 * Derived from the shape's usable inner area rather than a guessed multiplier, so
 * a diamond gets the room a diamond actually needs and its label is never shrunk
 * to fit after the fact.
 */
const measureNodeFor =
  (style: ElementStyle) =>
  (node: { label: string; shape: NodeShape }) => {
    const lines = wrapText(
      node.label,
      MAX_LABEL_WIDTH,
      LABEL_FONT_SIZE,
      style.fontFamily,
    );

    const content = {
      width: lines.reduce(
        (max, line) =>
          Math.max(
            max,
            measureTextWidth(line, LABEL_FONT_SIZE, style.fontFamily),
          ),
        0,
      ),
      height: Math.max(1, lines.length) * getLineHeight(LABEL_FONT_SIZE),
    };

    const required = getRequiredContainerSize(
      SHAPE_TOOLS[node.shape],
      content,
      NODE_PADDING,
    );

    return {
      width: Math.max(MIN_NODE_WIDTH, Math.ceil(required.width)),
      height: Math.max(MIN_NODE_HEIGHT, Math.ceil(required.height)),
    };
  };

/**
 * Find an existing element that can stand in for a graph node, so an
 * incremental request can connect new nodes to what is already on the canvas.
 * Matched on label text, which is what the model was shown.
 */
const findExistingNode = (
  label: string,
  existing: readonly Shape[],
): Shape | null => {
  const wanted = label.trim().toLowerCase();

  if (!wanted) {
    return null;
  }

  for (const element of existing) {
    if (element.tool !== "Text" || !element.containerId) {
      continue;
    }

    if ((element as TextShape).text.trim().toLowerCase() === wanted) {
      return (
        existing.find((candidate) => candidate.id === element.containerId) ?? null
      );
    }
  }

  return null;
};

export interface BuiltScene {
  elements: Shape[];
  /** Bounding box of what was added, for scrolling it into view. */
  bounds: { x: number; y: number; width: number; height: number };
  /** Ids of existing connectors the request asked to remove. */
  removedIds: string[];
}

/**
 * Build the elements for a graph. Returns only the *new* elements plus any
 * existing ones an edge had to bind to (already updated in place).
 */
export const buildSceneFromGraph = (
  graph: DiagramGraph,
  { origin, style = DEFAULT_STYLE, existing = [] }: BuildSceneOptions,
): BuiltScene => {
  const layout = layoutGraph(graph, { measureNode: measureNodeFor(style) });

  /** Graph node id -> the container element that represents it. */
  const containerFor = new Map<string, Shape>();
  const created: Shape[] = [];
  /** Existing elements an edge bound to, keyed so each is carried once. */
  const touchedExisting = new Map<string, Shape>();

  const place = (node: LaidOutNode): Shape => {
    const accent = ACCENT_COLORS[node.accent];

    const container = createElement(
      SHAPE_TOOLS[node.shape],
      {
        x: origin.x + node.x,
        y: origin.y + node.y,
        width: node.width,
        height: node.height,
      },
      accent.stroke,
      {
        ...style,
        stroke: accent.stroke,
        fill: accent.fill,
        fillStyle: "solid",
      },
    )!;

    const label = createElement(
      "Text",
      {
        text: node.label,
        fontSize: LABEL_FONT_SIZE,
        containerId: container.id,
      },
      accent.stroke,
      { ...style, stroke: accent.stroke, fontSize: LABEL_FONT_SIZE },
    ) as TextShape;

    const fitted = fitLabelToContainer(label, container);

    created.push(
      mutateElement(fitted.container, {
        boundElements: [{ id: fitted.label.id, type: "text" }],
      }),
      fitted.label,
    );

    return fitted.container;
  };

  for (const node of layout.nodes) {
    // Reuse a matching node already on the canvas rather than duplicating it.
    const reused = graph.replaceCanvas
      ? null
      : findExistingNode(node.label, existing);

    if (reused) {
      containerFor.set(node.id, reused);
      touchedExisting.set(reused.id, reused);
      continue;
    }

    containerFor.set(node.id, place(node));
  }

  /**
   * An incremental reply names existing nodes in its edges without repeating
   * them under `nodes`, so those have to be resolved against the canvas too.
   */
  const resolveEndpoint = (id: string): Shape | null => {
    const known = containerFor.get(id);
    if (known) {
      return known;
    }

    if (graph.replaceCanvas) {
      return null;
    }

    const existingNode = findExistingNode(id, existing);
    if (existingNode) {
      containerFor.set(id, existingNode);
      touchedExisting.set(existingNode.id, existingNode);
    }

    return existingNode;
  };

  // Containers must exist before edges can bind to them, so arrows are built
  // against the full element list.
  const scene: Shape[] = [...created];

  /**
   * Arrow plus the two endpoints it joins. Kept as a list of triples rather than
   * indexed against `graph.edges`, because edges that cannot be resolved are
   * skipped and any index-based pairing would then bind the wrong shapes.
   */
  const connectors: Array<{ arrowId: string; from: Shape; to: Shape }> = [];

  for (const edge of graph.edges) {
    const from = resolveEndpoint(edge.from);
    const to = resolveEndpoint(edge.to);

    if (!from || !to || from.id === to.id) {
      continue;
    }

    const fromCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 };

    const arrow = createElement(
      "Arrow",
      {
        x1: fromCenter.x,
        y1: fromCenter.y,
        x2: toCenter.x,
        y2: toCenter.y,
        strokeStyle: edge.dashed ? "dashed" : "solid",
        // Elbows keep a generated diagram legible: they meet shapes squarely
        // and step around anything between them.
        edgeStyle: "elbow",
      },
      style.stroke,
      { ...style, stroke: DEFAULT_STYLE.stroke, strokeStyle: edge.dashed ? "dashed" : "solid" },
    )!;

    scene.push(arrow);
    connectors.push({ arrowId: arrow.id, from, to });
  }

  // Bind once every element is present, then let the router resolve the routes.
  let working: Shape[] = [...existing, ...scene];

  const CONNECTOR_GAP = 8;

  for (const { arrowId, from, to } of connectors) {
    working = applyBindings(working, arrowId, {
      start: createBinding(
        from,
        { x: from.x + from.width / 2, y: from.y + from.height / 2 },
        CONNECTOR_GAP,
      ),
      end: createBinding(
        to,
        { x: to.x + to.width / 2, y: to.y + to.height / 2 },
        CONNECTOR_GAP,
      ),
    });
  }

  // Connectors the request asked to take away, e.g. the direct A -> B link when
  // something is being inserted between them.
  const removedIds: string[] = [];

  for (const removal of graph.removedEdges) {
    const from = findExistingNode(removal.from, existing);
    const to = findExistingNode(removal.to, existing);

    if (!from || !to) {
      continue;
    }

    for (const element of existing) {
      if (!isLinearShape(element)) {
        continue;
      }

      const joins =
        element.startBinding?.elementId === from.id &&
        element.endBinding?.elementId === to.id;

      if (joins) {
        removedIds.push(element.id);
      }
    }
  }

  // Keep only what is new, plus the existing elements bindings changed.
  const createdIds = new Set([...created, ...scene].map((element) => element.id));
  const removed = new Set(removedIds);
  const result = working.filter(
    (element) =>
      !removed.has(element.id) &&
      (createdIds.has(element.id) || touchedExisting.has(element.id)),
  );

  return {
    elements: result,
    bounds: {
      x: origin.x,
      y: origin.y,
      width: layout.width,
      height: layout.height,
    },
    removedIds,
  };
};

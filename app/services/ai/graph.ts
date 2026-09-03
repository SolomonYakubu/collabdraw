/**
 * The contract between the model and the canvas.
 *
 * The old endpoint asked the model for absolute pixel coordinates and then ran
 * some six hundred lines of heuristics — grid snapping, collision resolution,
 * connector re-anchoring, label merging — trying to rescue the results. Models
 * are unreliable at geometry and reliable at structure, so this asks only for
 * structure: nodes, and which nodes connect to which. Position, size, spacing
 * and the connectors themselves are then computed deterministically.
 *
 * That is the whole accuracy story: there is nothing left for the model to get
 * numerically wrong.
 */

export type NodeShape = "rectangle" | "ellipse" | "diamond";

export type NodeAccent = "none" | "blue" | "green" | "yellow" | "red" | "purple";

export interface GraphNode {
  id: string;
  label: string;
  shape: NodeShape;
  accent: NodeAccent;
}

export interface GraphEdge {
  from: string;
  to: string;
  label: string;
  /** A dashed connector, for optional or asynchronous relationships. */
  dashed: boolean;
}

export interface DiagramGraph {
  title: string;
  /** True when the request was to start over rather than extend the canvas. */
  replaceCanvas: boolean;
  /** Layout flow: top-to-bottom or left-to-right. */
  direction: "down" | "right";
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * Connections to take away, which is what "insert X between A and B" needs:
   * the direct A -> B link has to go.
   */
  removedEdges: Array<{ from: string; to: string }>;
  /** A short note back to the user about what was produced. */
  summary: string;
}

export const NODE_SHAPES: NodeShape[] = ["rectangle", "ellipse", "diamond"];
export const NODE_ACCENTS: NodeAccent[] = [
  "none",
  "blue",
  "green",
  "yellow",
  "red",
  "purple",
];

/** Backgrounds for each accent, and the stroke that goes with it. */
export const ACCENT_COLORS: Record<NodeAccent, { fill: string; stroke: string }> = {
  none: { fill: "transparent", stroke: "#1e1e1e" },
  blue: { fill: "#a5d8ff", stroke: "#1971c2" },
  green: { fill: "#b2f2bb", stroke: "#2f9e44" },
  yellow: { fill: "#ffec99", stroke: "#f08c00" },
  red: { fill: "#ffc9c9", stroke: "#e03131" },
  purple: { fill: "#d0bfff", stroke: "#6741d9" },
};

/**
 * Hues for connectors, handed out one per source component.
 *
 * A dense system diagram is dozens of same-coloured lines crossing each other,
 * and the question a reader is asking at every crossing is which line is which.
 * Giving every arrow that leaves one box a hue of its own answers it: a bundle
 * can be followed back to where it came from without tracing corners.
 *
 * Hues are ~36 degrees apart and interleave warm with cool, so components placed
 * next to each other get colours that are easy to tell apart. Weight matches the
 * accent strokes above, so connectors sit alongside the boxes rather than shout
 * over them, and each survives the hue-rotate the canvas applies in dark mode.
 */
export const CONNECTOR_COLORS: string[] = [
  "#1971c2",
  "#e8590c",
  "#099268",
  "#c2255c",
  "#f08c00",
  "#3b5bdb",
  "#66a80f",
  "#9c36b5",
  "#0c8599",
  "#e03131",
];

/** Caps that keep one request from producing an unusable wall of shapes. */
export const MAX_NODES = 40;
export const MAX_EDGES = 80;
export const MAX_LABEL_LENGTH = 60;

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const asBoolean = (value: unknown, fallback = false): boolean =>
  typeof value === "boolean" ? value : fallback;

const trimLabel = (value: unknown): string =>
  asString(value).replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH);

const asShape = (value: unknown): NodeShape =>
  NODE_SHAPES.includes(value as NodeShape) ? (value as NodeShape) : "rectangle";

const asAccent = (value: unknown): NodeAccent =>
  NODE_ACCENTS.includes(value as NodeAccent) ? (value as NodeAccent) : "none";

/**
 * Turn whatever the model returned into a graph that is safe to lay out:
 * ids unique and non-empty, edges pointing at nodes that exist, no self-loops,
 * no duplicates, and within the size caps.
 *
 * `knownIds` are nodes already on the canvas. An incremental reply refers to
 * those in its edges without re-listing them as nodes, so without this the new
 * connections would all be discarded as dangling — which is exactly what made
 * "add a cache between the API and the database" produce a floating box.
 *
 * Returns `null` only when there is nothing usable at all.
 */
export const parseDiagramGraph = (
  input: unknown,
  knownIds: ReadonlySet<string> = new Set(),
): DiagramGraph | null => {
  if (!input || typeof input !== "object") {
    return null;
  }

  const raw = input as Record<string, unknown>;
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];

  const nodes: GraphNode[] = [];
  const seenIds = new Set<string>();

  for (const candidate of rawNodes) {
    if (nodes.length >= MAX_NODES || !candidate || typeof candidate !== "object") {
      continue;
    }

    const node = candidate as Record<string, unknown>;
    const label = trimLabel(node.label);

    // An id is what edges refer to; fall back to the label, then to a counter.
    let id = asString(node.id).trim() || label || `n${nodes.length + 1}`;

    if (seenIds.has(id)) {
      let suffix = 2;
      while (seenIds.has(`${id}-${suffix}`)) {
        suffix += 1;
      }
      id = `${id}-${suffix}`;
    }

    seenIds.add(id);
    nodes.push({
      id,
      label: label || id,
      shape: asShape(node.shape),
      accent: asAccent(node.accent),
    });
  }

  // Edges may also point at nodes that are already on the canvas.
  const addressable = new Set([...seenIds, ...knownIds]);

  if (nodes.length === 0 && addressable.size === 0) {
    return null;
  }

  const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];
  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();

  for (const candidate of rawEdges) {
    if (edges.length >= MAX_EDGES || !candidate || typeof candidate !== "object") {
      continue;
    }

    const edge = candidate as Record<string, unknown>;
    const from = asString(edge.from).trim();
    const to = asString(edge.to).trim();

    // Drop edges that dangle or loop; both would break the layering.
    if (!addressable.has(from) || !addressable.has(to) || from === to) {
      continue;
    }

    const signature = `${from}->${to}`;
    if (seenEdges.has(signature)) {
      continue;
    }

    seenEdges.add(signature);
    edges.push({
      from,
      to,
      label: trimLabel(edge.label),
      dashed: asBoolean(edge.dashed),
    });
  }

  const rawRemoved = Array.isArray(raw.removedEdges) ? raw.removedEdges : [];
  const removedEdges: Array<{ from: string; to: string }> = [];

  for (const candidate of rawRemoved) {
    if (removedEdges.length >= MAX_EDGES || !candidate || typeof candidate !== "object") {
      continue;
    }

    const edge = candidate as Record<string, unknown>;
    const from = asString(edge.from).trim();
    const to = asString(edge.to).trim();

    if (from && to && from !== to) {
      removedEdges.push({ from, to });
    }
  }

  // Nothing to draw and nothing to remove means nothing usable.
  if (nodes.length === 0 && edges.length === 0 && removedEdges.length === 0) {
    return null;
  }

  return {
    title: trimLabel(raw.title),
    replaceCanvas: asBoolean(raw.replaceCanvas),
    direction: raw.direction === "right" ? "right" : "down",
    nodes,
    edges,
    removedEdges,
    summary: asString(raw.summary).trim().slice(0, 400),
  };
};

/**
 * Layered graph layout.
 *
 * A compact Sugiyama-style pass: break any cycles, assign each node to a layer by
 * its longest path from a root, order nodes within a layer to reduce crossings,
 * then place them on a regular grid. Because it is deterministic, the same graph
 * always produces the same diagram, and nothing can overlap.
 *
 * Node sizing is *not* decided here — the caller supplies `measureNode`, because
 * how much room a label needs depends on the shape that will hold it, and that
 * knowledge belongs with the code that builds the elements.
 */
import type { DiagramGraph, GraphNode } from "./graph";

export interface LaidOutNode extends GraphNode {
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
}

export interface DiagramLayout {
  nodes: LaidOutNode[];
  width: number;
  height: number;
}

export interface LayoutOptions {
  /** The box a node needs, including whatever padding its shape requires. */
  measureNode: (node: GraphNode) => { width: number; height: number };
  /** Gap between layers, along the flow direction. */
  layerGap?: number;
  /** Gap between siblings, across the flow direction. */
  siblingGap?: number;
}

const DEFAULTS = {
  layerGap: 90,
  siblingGap: 44,
};

/**
 * Edges that close a cycle, found by depth-first search.
 *
 * Layering has to run over a DAG. Without this, a loop — and a flowchart almost
 * always has one, "not resolved" going back to "investigate" — made the
 * relaxation below push its nodes forward on every round until it hit the round
 * cap. A six-node support-ticket chart came out twenty layers deep and 2500px
 * tall, with one connector spanning the gap.
 */
const findBackEdges = (graph: DiagramGraph): Set<number> => {
  const outgoing = new Map<string, Array<{ to: string; index: number }>>();

  graph.edges.forEach((edge, index) => {
    const list = outgoing.get(edge.from);
    if (list) {
      list.push({ to: edge.to, index });
    } else {
      outgoing.set(edge.from, [{ to: edge.to, index }]);
    }
  });

  /** 0 unvisited, 1 on the current path, 2 finished. */
  const state = new Map<string, 0 | 1 | 2>();
  const backEdges = new Set<number>();

  const visit = (id: string): void => {
    state.set(id, 1);

    for (const { to, index } of outgoing.get(id) ?? []) {
      const seen = state.get(to) ?? 0;

      if (seen === 1) {
        // Reaching a node still on the current path closes a cycle.
        backEdges.add(index);
      } else if (seen === 0) {
        visit(to);
      }
    }

    state.set(id, 2);
  };

  for (const node of graph.nodes) {
    if (!state.get(node.id)) {
      visit(node.id);
    }
  }

  return backEdges;
};

/** Longest path from a root, over the forward edges only. */
const assignLayers = (
  graph: DiagramGraph,
  forward: DiagramGraph["edges"],
): Map<string, number> => {
  const layer = new Map<string, number>();
  for (const node of graph.nodes) {
    layer.set(node.id, 0);
  }

  // Over a DAG this converges within the length of the longest path, which is
  // bounded by the node count.
  for (let round = 0; round < graph.nodes.length; round += 1) {
    let changed = false;

    for (const edge of forward) {
      const fromLayer = layer.get(edge.from) ?? 0;
      const toLayer = layer.get(edge.to) ?? 0;

      if (toLayer < fromLayer + 1) {
        layer.set(edge.to, fromLayer + 1);
        changed = true;
      }
    }

    if (!changed) {
      break;
    }
  }

  return layer;
};

/**
 * Order each layer to reduce edge crossings, by repeatedly moving nodes towards
 * the average position of their neighbours in the previous layer.
 */
const orderLayers = (
  graph: DiagramGraph,
  layers: Map<string, number>,
  forward: DiagramGraph["edges"],
): string[][] => {
  const byLayer: string[][] = [];

  for (const node of graph.nodes) {
    const index = layers.get(node.id) ?? 0;
    while (byLayer.length <= index) {
      byLayer.push([]);
    }
    byLayer[index].push(node.id);
  }

  const predecessors = new Map<string, string[]>();
  for (const edge of forward) {
    const list = predecessors.get(edge.to);
    if (list) {
      list.push(edge.from);
    } else {
      predecessors.set(edge.to, [edge.from]);
    }
  }

  // Two barycentre sweeps is plenty for diagrams of this size.
  for (let sweep = 0; sweep < 2; sweep += 1) {
    for (let index = 1; index < byLayer.length; index += 1) {
      const previous = byLayer[index - 1];
      const positionOf = new Map(previous.map((id, at) => [id, at]));

      const scored = byLayer[index].map((id, at) => {
        const parents = (predecessors.get(id) ?? []).filter((parent) =>
          positionOf.has(parent),
        );

        const barycentre =
          parents.length === 0
            ? at
            : parents.reduce((sum, parent) => sum + positionOf.get(parent)!, 0) /
              parents.length;

        return { id, barycentre, at };
      });

      // Ties keep their existing order, so the result stays stable.
      scored.sort((a, b) => a.barycentre - b.barycentre || a.at - b.at);
      byLayer[index] = scored.map((entry) => entry.id);
    }
  }

  return byLayer;
};

/** Lay a graph out with the origin at (0, 0). */
export const layoutGraph = (
  graph: DiagramGraph,
  options: LayoutOptions,
): DiagramLayout => {
  const {
    measureNode,
    layerGap = DEFAULTS.layerGap,
    siblingGap = DEFAULTS.siblingGap,
  } = options;

  const backEdges = findBackEdges(graph);
  const forward = graph.edges.filter((_, index) => !backEdges.has(index));

  const layers = assignLayers(graph, forward);
  const ordered = orderLayers(graph, layers, forward);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

  const sized = new Map<string, { width: number; height: number }>();
  for (const node of graph.nodes) {
    sized.set(node.id, measureNode(node));
  }

  const horizontal = graph.direction === "right";

  // Extent of each layer along the flow axis, and across it.
  const layerExtent = ordered.map((ids) =>
    ids.reduce(
      (max, id) =>
        Math.max(max, horizontal ? sized.get(id)!.width : sized.get(id)!.height),
      0,
    ),
  );

  const crossExtent = ordered.map((ids) =>
    ids.reduce(
      (total, id, index) =>
        total +
        (horizontal ? sized.get(id)!.height : sized.get(id)!.width) +
        (index > 0 ? siblingGap : 0),
      0,
    ),
  );

  const widestCross = Math.max(0, ...crossExtent);
  const nodes: LaidOutNode[] = [];

  let flowCursor = 0;

  ordered.forEach((ids, layerIndex) => {
    // Centre each layer across the flow, so the diagram reads symmetrically.
    let crossCursor = (widestCross - crossExtent[layerIndex]) / 2;

    for (const id of ids) {
      const node = nodeById.get(id)!;
      const size = sized.get(id)!;

      const flowSize = horizontal ? size.width : size.height;
      const crossSize = horizontal ? size.height : size.width;

      // Centre the node within its layer's band.
      const flowOffset = (layerExtent[layerIndex] - flowSize) / 2;

      nodes.push({
        ...node,
        layer: layerIndex,
        width: size.width,
        height: size.height,
        x: horizontal ? flowCursor + flowOffset : crossCursor,
        y: horizontal ? crossCursor : flowCursor + flowOffset,
      });

      crossCursor += crossSize + siblingGap;
    }

    flowCursor += layerExtent[layerIndex] + layerGap;
  });

  return {
    nodes,
    width: horizontal ? Math.max(0, flowCursor - layerGap) : widestCross,
    height: horizontal ? widestCross : Math.max(0, flowCursor - layerGap),
  };
};

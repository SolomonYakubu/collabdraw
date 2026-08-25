/**
 * Tiered layout for system designs.
 *
 * A system design reads in bands: clients at the front, then the edge (CDN,
 * firewall, load balancer), then services and their queues and caches, and
 * finally the data stores. The generic layered layout derives tiers from edge
 * direction, which scatters a database into the middle of the picture whenever
 * something writes back to it — so here the tier comes from what a component
 * *is*, with an explicit per-node override for the cases that need it.
 *
 * Within a tier, nodes stack across the flow axis centred on the band, mirroring
 * `layoutGraph`'s geometry so both layouts feel like the same product. Zones are
 * computed afterwards as bounding boxes of their members plus padding.
 */
import type { GraphNode } from "./graph";
import { DEFAULT_TIERS, type SystemSpec, type SystemNode } from "./system";

export interface LaidOutSystemNode extends SystemNode {
  x: number;
  y: number;
  width: number;
  height: number;
  tier: number;
}

export interface LaidOutZone {
  id: string;
  label: string;
  contains: string[];
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SystemLayout {
  nodes: LaidOutSystemNode[];
  zones: LaidOutZone[];
  width: number;
  height: number;
}

export interface SystemLayoutOptions {
  /** The box a node needs, including whatever padding its shape requires. */
  measureNode: (node: SystemNode) => { width: number; height: number };
  /** Gap between tier bands, along the flow direction. */
  tierGap?: number;
  /** Gap between siblings within a tier, across the flow direction. */
  siblingGap?: number;
  /** Padding added around a zone's members. */
  zonePadding?: number;
}

const DEFAULTS = {
  tierGap: 140,
  siblingGap: 72,
  zonePadding: 32,
};

/** Tiers are capped at six bands (0-5); anything beyond clamps to the last. */
const MAX_TIER = 5;

/**
 * Order each tier to reduce edge crossings and align dependent components
 * directly above/below each other along the flow axis.
 */
const orderTiers = (
  byTier: string[][],
  edges: SystemSpec["edges"],
): string[][] => {
  const ordered = byTier.map((tier) => [...tier]);

  const predecessors = new Map<string, string[]>();
  const successors = new Map<string, string[]>();

  for (const edge of edges) {
    const pList = predecessors.get(edge.to);
    if (pList) {
      pList.push(edge.from);
    } else {
      predecessors.set(edge.to, [edge.from]);
    }

    const sList = successors.get(edge.from);
    if (sList) {
      sList.push(edge.to);
    } else {
      successors.set(edge.from, [edge.to]);
    }
  }

  // Forward and backward barycentre sweeps
  for (let sweep = 0; sweep < 3; sweep += 1) {
    // Forward pass: align with any predecessors in earlier tiers
    for (let index = 1; index < ordered.length; index += 1) {
      // Build normalized position map of all preceding tiers (0 to index-1)
      const prevPosMap = new Map<string, number>();
      for (let pIdx = 0; pIdx < index; pIdx += 1) {
        const tier = ordered[pIdx];
        const count = tier.length;
        tier.forEach((id, at) => {
          // Normalize to [0, 1] across the tier
          prevPosMap.set(id, count > 1 ? at / (count - 1) : 0.5);
        });
      }

      const scored = ordered[index].map((id, at) => {
        const parents = (predecessors.get(id) ?? []).filter((p) =>
          prevPosMap.has(p),
        );
        const barycentre =
          parents.length === 0
            ? at / Math.max(1, ordered[index].length - 1)
            : parents.reduce((sum, p) => sum + prevPosMap.get(p)!, 0) /
              parents.length;
        return { id, barycentre, at };
      });

      scored.sort((a, b) => a.barycentre - b.barycentre || a.at - b.at);
      ordered[index] = scored.map((s) => s.id);
    }

    // Backward pass: align with any successors in later tiers
    for (let index = ordered.length - 2; index >= 0; index -= 1) {
      const nextPosMap = new Map<string, number>();
      for (let nIdx = index + 1; nIdx < ordered.length; nIdx += 1) {
        const tier = ordered[nIdx];
        const count = tier.length;
        tier.forEach((id, at) => {
          nextPosMap.set(id, count > 1 ? at / (count - 1) : 0.5);
        });
      }

      const scored = ordered[index].map((id, at) => {
        const children = (successors.get(id) ?? []).filter((c) =>
          nextPosMap.has(c),
        );
        const barycentre =
          children.length === 0
            ? at / Math.max(1, ordered[index].length - 1)
            : children.reduce((sum, c) => sum + nextPosMap.get(c)!, 0) /
              children.length;
        return { id, barycentre, at };
      });

      scored.sort((a, b) => a.barycentre - b.barycentre || a.at - b.at);
      ordered[index] = scored.map((s) => s.id);
    }
  }

  return ordered;
};

/**
 * Lay a system spec out with the origin at (0, 0). Deterministic: same spec,
 * same picture — ties keep insertion order rather than comparing on anything
 * unstable.
 */
export const layoutSystemGraph = (
  spec: SystemSpec,
  options: SystemLayoutOptions,
): SystemLayout => {
  const {
    measureNode,
    tierGap = DEFAULTS.tierGap,
    siblingGap = DEFAULTS.siblingGap,
    zonePadding = DEFAULTS.zonePadding,
  } = options;

  const horizontal = spec.direction === "right";

  const sized = new Map<string, { width: number; height: number }>();
  for (const node of spec.nodes) {
    sized.set(node.id, measureNode(node));
  }

  // Group node ids by tier
  const rawByTier: string[][] = [];
  for (const node of spec.nodes) {
    const tier = Math.min(
      MAX_TIER,
      node.tier ?? DEFAULT_TIERS[node.type] ?? 3,
    );
    while (rawByTier.length <= tier) {
      rawByTier.push([]);
    }
    rawByTier[tier].push(node.id);
  }
  // Drop trailing empty tiers so an all-services spec is not extra gaps tall.
  while (rawByTier.length > 0 && rawByTier[rawByTier.length - 1].length === 0) {
    rawByTier.pop();
  }

  const byTier = orderTiers(rawByTier, spec.edges);

  const nodeById = new Map(spec.nodes.map((node) => [node.id, node]));

  // Extent of each tier along the flow axis, and total extent across it.
  const tierExtent = byTier.map((ids) =>
    ids.reduce(
      (max, id) =>
        Math.max(
          max,
          horizontal ? sized.get(id)!.width : sized.get(id)!.height,
        ),
      0,
    ),
  );

  const crossExtent = byTier.map((ids) =>
    ids.reduce(
      (total, id, index) =>
        total +
        (horizontal ? sized.get(id)!.height : sized.get(id)!.width) +
        (index > 0 ? siblingGap : 0),
      0,
    ),
  );

  const widestCross = Math.max(0, ...crossExtent);

  const nodes: LaidOutSystemNode[] = [];
  let flowCursor = 0;

  byTier.forEach((ids, tierIndex) => {
    // Centre each tier's stack across the flow, so bands read symmetrically.
    let crossCursor = (widestCross - crossExtent[tierIndex]) / 2;

    for (const id of ids) {
      const node = nodeById.get(id)!;
      const size = sized.get(id)!;

      const flowSize = horizontal ? size.width : size.height;
      const crossSize = horizontal ? size.height : size.width;

      // Centre the node within its tier's band.
      const flowOffset = (tierExtent[tierIndex] - flowSize) / 2;

      nodes.push({
        ...node,
        tier: tierIndex,
        width: size.width,
        height: size.height,
        x: horizontal ? flowCursor + flowOffset : crossCursor,
        y: horizontal ? crossCursor : flowCursor + flowOffset,
      });

      crossCursor += crossSize + siblingGap;
    }

    flowCursor += tierExtent[tierIndex] + tierGap;
  });

  const contentWidth = horizontal
    ? Math.max(0, flowCursor - tierGap)
    : widestCross;
  const contentHeight = horizontal
    ? widestCross
    : Math.max(0, flowCursor - tierGap);

  // Zones wrap their members' laid-out boxes plus padding.
  const placedById = new Map(nodes.map((node) => [node.id, node]));
  const zones: LaidOutZone[] = [];

  for (const zone of spec.zones) {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let found = false;

    for (const id of zone.contains) {
      const placed = placedById.get(id);
      if (!placed) {
        continue;
      }

      found = true;
      minX = Math.min(minX, placed.x);
      minY = Math.min(minY, placed.y);
      maxX = Math.max(maxX, placed.x + placed.width);
      maxY = Math.max(maxY, placed.y + placed.height);
    }

    if (!found) {
      continue;
    }

    zones.push({
      id: zone.id,
      label: zone.label,
      contains: zone.contains,
      x: minX - zonePadding,
      y: minY - zonePadding,
      width: maxX - minX + zonePadding * 2,
      height: maxY - minY + zonePadding * 2,
    });
  }

  return {
    nodes,
    zones,
    width: contentWidth,
    height: contentHeight,
  };
};

export type { GraphNode };

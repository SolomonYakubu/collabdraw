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
  /**
   * Index of the row this node sits on, counted across the whole drawing rather
   * than within its tier. A wide tier wraps onto several rows, so "which band
   * am I in" and "which tier am I in" stop being the same question — and it is
   * the band that decides which channel a connector has to cross.
   */
  band: number;
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
  /** Gap between the wrapped rows of a single tier, along the flow direction. */
  rowGap?: number;
  /**
   * How wide a tier may get across the flow before it wraps onto another row.
   * A fourteen-service tier on one row is ~2900px: it needs a 3x zoom-out to
   * fit, at which point the labels are unreadable, and every connector into it
   * has to traverse the whole width, which is what piles routes into the same
   * lane.
   */
  maxTierCross?: number;
  /** Padding added around a zone's members. */
  zonePadding?: number;
  /**
   * Extra room to add after band `band`, on top of the row or tier gap.
   *
   * Connectors are given a lane of their own in the channel between two bands
   * (see `planSystemRoutes`), and a channel with eleven lanes needs more room
   * than one with two. The caller lays out once to learn the bands, counts the
   * lanes, then lays out again with this hook — band assignment does not depend
   * on the gaps, so the second pass only moves things along the flow axis.
   */
  extraGapAfterBand?: (band: number) => number;
}

const DEFAULTS = {
  tierGap: 140,
  siblingGap: 72,
  rowGap: 104,
  maxTierCross: 1500,
  zonePadding: 32,
};

/** The gaps a layout uses when the caller does not override them. */
export const SYSTEM_LAYOUT_DEFAULTS: Readonly<typeof DEFAULTS> = DEFAULTS;

/** Tiers are capped at six bands (0-5); anything beyond clamps to the last. */
const MAX_TIER = 5;

/**
 * Split one tier's ordered ids into rows that each fit within `budget`.
 *
 * Rows are balanced rather than greedily filled: fourteen services become
 * 5/5/4, not 6/6/2. A greedy fill leaves a stub row whose nodes get centred
 * under a wide row above, which reads as an accident rather than a grid.
 */
const splitIntoRows = (
  ids: readonly string[],
  crossSizeOf: (id: string) => number,
  siblingGap: number,
  budget: number,
): string[][] => {
  if (ids.length <= 1) {
    return ids.length === 0 ? [] : [[...ids]];
  }

  const total = ids.reduce(
    (sum, id, index) => sum + crossSizeOf(id) + (index > 0 ? siblingGap : 0),
    0,
  );

  if (total <= budget) {
    return [[...ids]];
  }

  const rowCount = Math.min(ids.length, Math.max(2, Math.ceil(total / budget)));
  const perRow = Math.ceil(ids.length / rowCount);

  const rows: string[][] = [];
  for (let at = 0; at < ids.length; at += perRow) {
    rows.push([...ids.slice(at, at + perRow)]);
  }

  return rows;
};

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
    rowGap = DEFAULTS.rowGap,
    maxTierCross = DEFAULTS.maxTierCross,
    zonePadding = DEFAULTS.zonePadding,
    extraGapAfterBand,
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

  const flowSizeOf = (id: string) =>
    horizontal ? sized.get(id)!.width : sized.get(id)!.height;
  const crossSizeOf = (id: string) =>
    horizontal ? sized.get(id)!.height : sized.get(id)!.width;

  // A tier is a band of one or more rows: wide tiers wrap so the drawing stays
  // roughly screen-shaped instead of growing sideways without limit.
  const bands: Array<{ tier: number; ids: string[] }> = [];
  byTier.forEach((ids, tierIndex) => {
    for (const row of splitIntoRows(ids, crossSizeOf, siblingGap, maxTierCross)) {
      bands.push({ tier: tierIndex, ids: row });
    }
  });

  // Extent of each band along the flow axis, and total extent across it.
  const bandFlow = bands.map(({ ids }) =>
    ids.reduce((max, id) => Math.max(max, flowSizeOf(id)), 0),
  );

  const bandCross = bands.map(({ ids }) =>
    ids.reduce(
      (total, id, index) =>
        total + crossSizeOf(id) + (index > 0 ? siblingGap : 0),
      0,
    ),
  );

  const widestCross = Math.max(0, ...bandCross);

  const nodes: LaidOutSystemNode[] = [];
  let flowCursor = 0;
  let trailingGap = 0;

  bands.forEach(({ tier, ids }, bandIndex) => {
    // Centre each band's stack across the flow, so rows read symmetrically.
    let crossCursor = (widestCross - bandCross[bandIndex]) / 2;

    for (const id of ids) {
      const node = nodeById.get(id)!;
      const size = sized.get(id)!;

      // Centre the node within its band.
      const flowOffset = (bandFlow[bandIndex] - flowSizeOf(id)) / 2;

      nodes.push({
        ...node,
        tier,
        band: bandIndex,
        width: size.width,
        height: size.height,
        x: horizontal ? flowCursor + flowOffset : crossCursor,
        y: horizontal ? crossCursor : flowCursor + flowOffset,
      });

      crossCursor += crossSizeOf(id) + siblingGap;
    }

    // Rows of the same tier sit closer together than two different tiers do.
    const next = bands[bandIndex + 1];
    trailingGap =
      (next && next.tier === tier ? rowGap : tierGap) +
      (extraGapAfterBand?.(bandIndex) ?? 0);
    flowCursor += bandFlow[bandIndex] + trailingGap;
  });

  // The last band contributed a trailing gap that no band follows.
  const contentFlow = Math.max(0, flowCursor - trailingGap);

  const contentWidth = horizontal ? contentFlow : widestCross;
  const contentHeight = horizontal ? widestCross : contentFlow;

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

/* ------------------------------------------------------------------ *
 * Which way round to draw it
 * ------------------------------------------------------------------ */

/**
 * The shape a drawing should aim for. Screens are landscape, so a picture wider
 * than it is tall can be read at a glance where a tall one has to be scrolled.
 */
const TARGET_ASPECT = 16 / 10;

/**
 * How far a laid-out picture is from that shape, in log space so that twice too
 * wide scores the same as twice too tall. 0 is a perfect fit.
 */
export const shapePenalty = ({
  width,
  height,
}: {
  width: number;
  height: number;
}): number =>
  Math.abs(
    Math.log(Math.max(1, width) / Math.max(1, height) / TARGET_ASPECT),
  );

/**
 * How much better shaped the alternative has to be before it is worth turning a
 * design on its side. Top-to-bottom is the convention a reader expects from an
 * architecture diagram — clients above, data stores below — so a marginal win in
 * aspect ratio is not worth breaking it for.
 *
 * 0.2 in log space is "a fifth better fit". Measured against the 31-component
 * social platform fixture, that is the line between the two cases: drawn downward
 * it is 1479x2205, two and a half screens deep, against 2805x960 turned, and it
 * turns; a fourteen-service fan-out, already a comfortable 1272x993 downward,
 * stays as it is.
 */
const TURN_MARGIN = 0.2;

/**
 * Which direction to draw a design that did not ask for one: `down` unless
 * `right` fits the screen appreciably better.
 *
 * A design's proportions come from its own shape, not from the request. Six
 * tiers with two components each is naturally tall; six tiers where one holds
 * fourteen services is naturally wide, and drawn downward it becomes a portrait
 * picture several screens deep. Both candidates are laid out and measured rather
 * than guessed at from node counts, because a wide tier wraps and a label
 * decides how big its box is — neither is knowable without doing the work.
 */
export const pickDirection = (
  down: { width: number; height: number },
  right: { width: number; height: number },
): "down" | "right" =>
  shapePenalty(down) - shapePenalty(right) > TURN_MARGIN ? "right" : "down";

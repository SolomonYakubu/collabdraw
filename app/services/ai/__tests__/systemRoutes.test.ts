/**
 * Connector legibility for system diagrams.
 *
 * The canvas elbow router solves one arrow at a time, which is correct per arrow
 * and unreadable in bulk: every connector leaving the bottom of a box leaves from
 * the same anchor, and every route crossing the space between two rows picks the
 * same cheapest line. `planSystemRoutes` plans them together instead, and these
 * tests hold that plan to the properties that make the picture readable — no
 * connector through a component, and no two unrelated connectors drawn along the
 * same line.
 *
 * The fixture is the diagram that first showed the problem: a 31-component social
 * platform whose fourteen services once sat on one 2900px row with dozens of
 * arrows stacked on top of each other.
 */
import { describe, expect, it } from "vitest";

import { getElementBounds } from "../../canvas/elements";
import { getLinearPath } from "../../canvas/linearElement";
import { isLinearShape } from "../../../types/shapes";
import type { BoundingBox, Point, Shape } from "../../../types/shapes";
import { buildSceneFromSystemGraph } from "../buildScene";
import { parseSystemSpec } from "../system";
import { layoutSystemGraph, SYSTEM_LAYOUT_DEFAULTS } from "../systemLayout";
import { extraGapForLanes, planSystemRoutes } from "../systemRoutes";
import {
  PLATFORM_EDGES,
  PLATFORM_NODES,
  PLATFORM_ZONES,
} from "./fixtures/platform";

const specOf = (
  nodes: Array<[string, string, string]>,
  edges: Array<[string, string]> = [],
  extra: Record<string, unknown> = {},
) =>
  parseSystemSpec({
    direction: "down",
    nodes: nodes.map(([id, label, type]) => ({ id, label, type })),
    edges: edges.map(([from, to]) => ({ from, to, label: "", dashed: false })),
    zones: [],
    ...extra,
  })!;

const measureNode = (node: { label: string }) => ({
  width: 60 + node.label.length * 8,
  height: 56,
});

const platformSpec = (direction: "down" | "right") =>
  specOf(PLATFORM_NODES, PLATFORM_EDGES, { direction, zones: PLATFORM_ZONES });

/** Does an axis-aligned segment pass through a box's interior? */
const segmentHitsBox = (a: Point, b: Point, box: BoundingBox): boolean => {
  // A connector is allowed to graze a border on its way to an anchor.
  const pad = 2;

  return (
    Math.max(a.x, b.x) > box.x + pad &&
    Math.min(a.x, b.x) < box.x + box.width - pad &&
    Math.max(a.y, b.y) > box.y + pad &&
    Math.min(a.y, b.y) < box.y + box.height - pad
  );
};

/** How much of the same line two segments share, 0 unless they are collinear. */
const overlapLength = (a: readonly Point[], b: readonly Point[]): number => {
  const aHorizontal = Math.abs(a[0].y - a[1].y) < 0.5;
  const bHorizontal = Math.abs(b[0].y - b[1].y) < 0.5;

  if (aHorizontal !== bHorizontal) {
    return 0;
  }

  const along: "x" | "y" = aHorizontal ? "x" : "y";
  const across: "x" | "y" = aHorizontal ? "y" : "x";

  if (Math.abs(a[0][across] - b[0][across]) > 1.5) {
    return 0;
  }

  const low = Math.max(
    Math.min(a[0][along], a[1][along]),
    Math.min(b[0][along], b[1][along]),
  );
  const high = Math.min(
    Math.max(a[0][along], a[1][along]),
    Math.max(b[0][along], b[1][along]),
  );

  return Math.max(0, high - low);
};

/** Zone group boxes are the only dashed, faded rectangles in a built scene. */
const isZoneBox = (element: Shape) =>
  element.strokeStyle === "dashed" && (element.opacity ?? 1) < 0.8;

interface Defects {
  /** Times a connector segment passes through a component box. */
  throughComponents: number;
  /** Pairs of connectors sharing a stretch of line longer than the threshold. */
  doubled: number;
  /** Line shared by two connectors with no component in common. */
  strangers: number;
  /** Longest single stretch shared by two such connectors. */
  worstStranger: number;
  /** Total connector line drawn, to measure the rest against. */
  drawn: number;
}

/**
 * Connectors leaving one box share its anchor and fan out to their own ports, so
 * a stub of one is drawn over its neighbours' by design, and connectors meeting
 * at a box come in along the same approach. Line shared by two connectors that
 * touch neither the same source nor the same target is the actual defect: two
 * unrelated things drawn as one.
 */
const measureDefects = (elements: readonly Shape[]): Defects => {
  const arrows = elements.filter(isLinearShape);
  const components = elements
    .filter(
      (element) =>
        !isLinearShape(element) &&
        element.tool !== "Text" &&
        !isZoneBox(element),
    )
    .map(getElementBounds);

  const joins = new Map(
    arrows.map((arrow) => [
      arrow.id,
      [arrow.startBinding?.elementId, arrow.endBinding?.elementId].filter(
        (id): id is string => Boolean(id),
      ),
    ]),
  );

  const segments: Array<{ arrow: string; ends: Point[] }> = [];
  for (const arrow of arrows) {
    const path = getLinearPath(arrow);
    for (let at = 0; at + 1 < path.length; at += 1) {
      segments.push({ arrow: arrow.id, ends: [path[at], path[at + 1]] });
    }
  }

  let throughComponents = 0;
  let drawn = 0;
  for (const { ends } of segments) {
    drawn += Math.hypot(ends[1].x - ends[0].x, ends[1].y - ends[0].y);

    for (const box of components) {
      if (segmentHitsBox(ends[0], ends[1], box)) {
        throughComponents += 1;
      }
    }
  }

  let doubled = 0;
  let strangers = 0;
  let worstStranger = 0;

  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      if (segments[i].arrow === segments[j].arrow) {
        continue;
      }

      const length = overlapLength(segments[i].ends, segments[j].ends);

      // Below this two lines cross rather than run together.
      if (length <= 12) {
        continue;
      }

      doubled += length;

      const shares = joins
        .get(segments[i].arrow)!
        .some((id) => joins.get(segments[j].arrow)!.includes(id));

      if (!shares) {
        strangers += length;
        worstStranger = Math.max(worstStranger, length);
      }
    }
  }

  return { throughComponents, doubled, strangers, worstStranger, drawn };
};

describe("system diagram connectors", () => {
  for (const direction of ["down", "right"] as const) {
    describe(`flowing ${direction}`, () => {
      const { elements, bounds } = buildSceneFromSystemGraph(
        platformSpec(direction),
        { origin: { x: 0, y: 0 } },
      );
      const defects = measureDefects(elements);

      it("never runs a connector through a component", () => {
        expect(defects.throughComponents).toBe(0);
      });

      it("never draws two unrelated connectors along the same line", () => {
        // Not zero: a few short stretches belong to legs the elbow router adds
        // for itself, on its own grid, which the plan does not own.
        expect(defects.strangers / defects.drawn).toBeLessThan(0.015);
        expect(defects.worstStranger).toBeLessThanOrEqual(96);
      });

      it("keeps the doubled line to a fraction of the picture", () => {
        // Routing each connector on its own left ~23000px of doubled line on
        // this diagram; planning them together leaves ~3000.
        expect(defects.doubled).toBeLessThan(6000);
      });

      it("wraps a wide tier rather than running off the side", () => {
        const cross = direction === "right" ? bounds.height : bounds.width;
        expect(cross).toBeLessThanOrEqual(SYSTEM_LAYOUT_DEFAULTS.maxTierCross);
      });
    });
  }
});

describe("planSystemRoutes", () => {
  const planFor = (spec: ReturnType<typeof specOf>) => {
    const layout = layoutSystemGraph(spec, { measureNode });
    const plan = planSystemRoutes(layout, spec.edges, spec.direction ?? "down");
    return { layout, plan };
  };

  it("fans the connectors leaving one box out to their own ports", () => {
    const spec = specOf(
      [
        ["gw", "Gateway", "gateway"],
        ["a", "Alpha", "service"],
        ["b", "Bravo", "service"],
        ["c", "Charlie", "service"],
      ],
      [
        ["gw", "a"],
        ["gw", "b"],
        ["gw", "c"],
      ],
    );

    const { plan } = planFor(spec);
    const ports = plan.routes.map((route) => route.waypoints[0].x);

    expect(new Set(ports).size).toBe(3);
    // In target order, so the connectors do not cross on the way out.
    expect([...ports]).toEqual([...ports].sort((p, q) => p - q));
  });

  it("gives a busy channel more than one lane to share out", () => {
    const spec = platformSpec("down");
    const layout = layoutSystemGraph(spec, { measureNode });
    const { laneCount } = planSystemRoutes(
      layout,
      spec.edges,
      spec.direction ?? "down",
    );

    // The gateway fans out to eleven services: those runs cannot all sit on the
    // same line across the channel.
    expect(Math.max(...laneCount.values())).toBeGreaterThan(1);
  });

  it("staircases a connector that skips bands", () => {
    const spec = specOf(
      [
        ["c", "Client", "client"],
        ["gw", "Gateway", "gateway"],
        ["a", "Alpha", "service"],
        ["b", "Bravo", "service"],
        ["db", "Store", "database"],
      ],
      [
        ["c", "db"],
        ["gw", "a"],
        ["gw", "b"],
      ],
    );

    const { plan } = planFor(spec);
    const long = plan.routes.find((route) => route.edge === 0)!;

    // One turn per channel it passes through, rather than a single straight drop
    // down a column it would share with the next long connector.
    expect(new Set(long.waypoints.map((point) => point.y)).size).toBeGreaterThan(
      2,
    );
  });

  it("leaves a connector inside one band to the elbow router", () => {
    const spec = specOf(
      [
        ["a", "Alpha", "service"],
        ["b", "Bravo", "service"],
      ],
      [["a", "b"]],
    );

    expect(planFor(spec).plan.routes).toEqual([]);
  });
});

describe("extraGapForLanes", () => {
  it("asks for nothing when the base gap already holds the lanes", () => {
    const extra = extraGapForLanes(new Map([[0, 1]]), 400);

    expect(extra(0)).toBe(0);
    // A channel nothing crosses.
    expect(extra(7)).toBe(0);
  });

  it("caps how far one channel may grow", () => {
    expect(extraGapForLanes(new Map([[0, 40]]), 104, 260)(0)).toBe(260);
  });
});

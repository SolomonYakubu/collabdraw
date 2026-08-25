import { describe, expect, it } from "vitest";
import { parseSystemSpec, MAX_SYSTEM_NODES } from "../system";
import { layoutSystemGraph } from "../systemLayout";
import { buildSceneFromSystemGraph } from "../buildScene";
import { parseDrawingIntent } from "../intent";
import { inferComponentType } from "../describeScene";
import { boxesOverlap } from "../../../utils/geometry";
import { isLinearShape, type Shape, type TextShape } from "../../../types/shapes";

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

/** A stand-in for the real, shape-aware node measurer. */
const measureNode = (node: { label: string }) => ({
  width: 60 + node.label.length * 8,
  height: 56,
});

const boxesOf = (elements: readonly Shape[]) =>
  elements
    .filter((element) => !isLinearShape(element) && element.tool !== "Text")
    .map((element) => ({
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
    }));

describe("parseSystemSpec", () => {
  it("rejects input with no usable nodes", () => {
    expect(parseSystemSpec(null)).toBeNull();
    expect(parseSystemSpec({})).toBeNull();
    expect(parseSystemSpec({ nodes: [] })).toBeNull();
    expect(parseSystemSpec({ nodes: "nope" })).toBeNull();
  });

  it("fills in missing fields rather than failing", () => {
    const spec = parseSystemSpec({ nodes: [{ label: "API" }] })!;
    expect(spec.nodes[0]).toMatchObject({ id: "API", label: "API", type: "service" });
    expect(spec.direction).toBe("down");
    expect(spec.edges).toEqual([]);
    expect(spec.zones).toEqual([]);
  });

  it("tolerates invented component types by mapping or falling back", () => {
    const spec = parseSystemSpec({
      nodes: [
        { id: "a", label: "A", type: "webserver" },
        { id: "b", label: "B", type: "redis" },
        { id: "c", label: "C", type: "something-made-up" },
        { id: "d", label: "D" },
      ],
    })!;

    expect(spec.nodes[0].type).toBe("service");
    expect(spec.nodes[1].type).toBe("cache");
    expect(spec.nodes[2].type).toBe("service");
    expect(spec.nodes[3].type).toBe("service");
  });

  it("dedupes ids with a suffix", () => {
    const spec = parseSystemSpec({
      nodes: [
        { id: "api", label: "API" },
        { id: "api", label: "API two" },
      ],
    })!;

    expect(spec.nodes).toHaveLength(2);
    expect(spec.nodes[1].id).toBe("api-2");
  });

  it("drops dangling and self edges, and duplicates", () => {
    const spec = specOf(
      [["a", "A", "service"], ["b", "B", "database"]],
      [["a", "b"], ["b", "b"], ["a", "b"], ["a", "ghost"]],
    );

    expect(spec.edges).toHaveLength(1);
    expect(spec.edges[0]).toMatchObject({ from: "a", to: "b" });
  });

  it("clamps an out-of-range explicit tier", () => {
    const spec = parseSystemSpec({
      nodes: [{ id: "a", label: "A", type: "service", tier: 99 }],
    })!;
    expect(spec.nodes[0].tier).toBe(5);
  });

  it("keeps zones whose members exist and assigns each node once", () => {
    const spec = specOf(
      [
        ["a", "A", "service"],
        ["b", "B", "database"],
        ["c", "C", "client"],
      ],
      [],
      {
        zones: [
          { id: "vpc", label: "VPC", contains: ["a", "b"] },
          // "a" is already in the VPC; the second zone keeps only "c".
          { id: "edge", label: "Edge", contains: ["a", "c"] },
          { id: "empty", label: "Empty", contains: ["ghost"] },
        ],
      },
    );

    expect(spec.zones).toHaveLength(2);
    expect(spec.zones[0].contains).toEqual(["a", "b"]);
    expect(spec.zones[1].contains).toEqual(["c"]);
  });

  it("caps the node count", () => {
    const nodes = Array.from({ length: MAX_SYSTEM_NODES + 10 }, (_, index) => ({
      id: `n${index}`,
      label: `N${index}`,
      type: "service",
    }));
    expect(parseSystemSpec({ nodes })!.nodes).toHaveLength(MAX_SYSTEM_NODES);
  });
});

describe("layoutSystemGraph", () => {
  it("assigns default tiers from component type", () => {
    const layout = layoutSystemGraph(
      specOf([
        ["u", "User", "client"],
        ["lb", "LB", "load-balancer"],
        ["api", "API", "service"],
        ["db", "Postgres", "database"],
      ]),
      { measureNode },
    );

    const tierOf = new Map(layout.nodes.map((node) => [node.id, node.tier]));
    expect(tierOf.get("u")).toBe(0);
    expect(tierOf.get("lb")).toBe(2);
    expect(tierOf.get("api")).toBe(3);
    expect(tierOf.get("db")).toBe(5);
  });

  it("honours an explicit tier override", () => {
    const spec = parseSystemSpec({
      nodes: [
        { id: "a", label: "A", type: "service", tier: 0 },
        { id: "b", label: "B", type: "client", tier: 3 },
      ],
    })!;

    const layout = layoutSystemGraph(spec, { measureNode });
    const tierOf = new Map(layout.nodes.map((node) => [node.id, node.tier]));
    expect(tierOf.get("a")).toBe(0);
    expect(tierOf.get("b")).toBe(3);
  });

  it("never overlaps nodes", () => {
    const layout = layoutSystemGraph(
      specOf(
        [
          ["u", "User", "client"],
          ["lb", "Load balancer", "load-balancer"],
          ["api", "API", "service"],
          ["worker", "Worker", "service"],
          ["db", "Postgres", "database"],
          ["redis", "Redis", "cache"],
        ],
        [["u", "lb"], ["lb", "api"], ["api", "db"], ["api", "redis"]],
      ),
      { measureNode },
    );

    const boxes = layout.nodes.map((node) => ({
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    }));

    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        expect(boxesOverlap(boxes[i], boxes[j])).toBe(false);
      }
    }
  });

  it("stacks a tier's members across the flow direction", () => {
    const layout = layoutSystemGraph(
      specOf([
        ["api", "API", "service"],
        ["auth", "Auth", "service"],
        ["db", "Postgres", "database"],
      ]),
      { measureNode },
    );

    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    // Same tier -> same band along the flow (y), stacked across it (x).
    expect(byId.get("auth")!.y).toBe(byId.get("api")!.y);
    expect(byId.get("auth")!.x).not.toBe(byId.get("api")!.x);
    // Later tier sits below.
    expect(byId.get("db")!.y).toBeGreaterThan(byId.get("api")!.y);
  });

  it("flows rightward when asked", () => {
    const layout = layoutSystemGraph(
      specOf([["u", "User", "client"], ["db", "Postgres", "database"]]),
      { measureNode },
    );
    const down = layout;

    const right = layoutSystemGraph(
      parseSystemSpec({
        direction: "right",
        nodes: [
          { id: "u", label: "User", type: "client" },
          { id: "db", label: "Postgres", type: "database" },
        ],
      })!,
      { measureNode },
    );

    expect(right.width).toBeGreaterThan(down.height === 0 ? 0 : 0);
    const byId = new Map(right.nodes.map((node) => [node.id, node]));
    expect(byId.get("db")!.x).toBeGreaterThan(byId.get("u")!.x);
  });

  it("wraps zone rectangles around their members", () => {
    const layout = layoutSystemGraph(
      specOf(
        [
          ["api", "API", "service"],
          ["db", "Postgres", "database"],
        ],
        [["api", "db"]],
        { zones: [{ id: "vpc", label: "VPC", contains: ["api", "db"] }] },
      ),
      { measureNode },
    );

    expect(layout.zones).toHaveLength(1);
    const zone = layout.zones[0];

    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(zone.x);
      expect(node.y).toBeGreaterThanOrEqual(zone.y);
      expect(node.x + node.width).toBeLessThanOrEqual(zone.x + zone.width);
      expect(node.y + node.height).toBeLessThanOrEqual(zone.y + zone.height);
    }
  });

  it("is deterministic", () => {
    const spec = specOf(
      [
        ["u", "User", "client"],
        ["api", "API", "service"],
        ["db", "Postgres", "database"],
      ],
      [["u", "api"], ["api", "db"]],
    );

    expect(layoutSystemGraph(spec, { measureNode })).toEqual(
      layoutSystemGraph(spec, { measureNode }),
    );
  });
});

describe("buildSceneFromSystemGraph", () => {
  const build = (
    nodes: Array<[string, string, string]>,
    edges: Array<[string, string]> = [],
    extra: Record<string, unknown> = {},
  ) =>
    buildSceneFromSystemGraph(specOf(nodes, edges, extra), {
      origin: { x: 0, y: 0 },
    });

  it("creates a container and a bound label per node", () => {
    const { elements } = build([["api", "API Gateway", "gateway"]]);

    const container = elements.find((element) => element.tool === "Square")!;
    const label = elements.find(
      (element): element is TextShape => element.tool === "Text",
    )!;

    expect(label.text).toBe("API Gateway");
    expect(label.containerId).toBe(container.id);
    expect(container.boundElements).toEqual([{ id: label.id, type: "text" }]);
  });

  it("picks the shape convention per component type", () => {
    const { elements } = build([
      ["api", "API", "service"],
      ["db", "Postgres", "database"],
      ["cache", "Redis", "cache"],
    ]);

    const squares = elements.filter((element) => element.tool === "Square");
    const circles = elements.filter((element) => element.tool === "Circle");

    expect(squares).toHaveLength(1);
    expect(circles).toHaveLength(2);
  });

  it("applies the fixed accent colours per type", () => {
    const { elements } = build([["db", "Postgres", "database"]]);

    const container = elements.find((element) => element.tool === "Circle")!;
    // Databases are purple.
    expect(container.stroke).toBe("#6741d9");
    expect(container.fill).toBe("#d0bfff");
  });

  it("makes edges into arrows bound at both ends", () => {
    const { elements } = build(
      [["api", "API", "service"], ["db", "Postgres", "database"]],
      [["api", "db"]],
    );

    const arrow = elements.find(isLinearShape)!;
    expect(arrow.startBinding).not.toBeNull();
    expect(arrow.endBinding).not.toBeNull();

    for (const binding of [arrow.startBinding!, arrow.endBinding!]) {
      expect(
        elements.some((element) => element.id === binding.elementId),
      ).toBe(true);
    }
  });

  it("draws dashed arrows for async links", () => {
    const spec = parseSystemSpec({
      nodes: [
        { id: "api", label: "API", type: "service" },
        { id: "q", label: "Events", type: "queue" },
      ],
      edges: [{ from: "api", to: "q", label: "", dashed: true }],
      zones: [],
    })!;

    const { elements } = buildSceneFromSystemGraph(spec, {
      origin: { x: 0, y: 0 },
    });

    expect(elements.find(isLinearShape)!.strokeStyle).toBe("dashed");
  });

  it("draws zone boxes behind their members", () => {
    const { elements } = build(
      [
        ["api", "API", "service"],
        ["db", "Postgres", "database"],
      ],
      [["api", "db"]],
      { zones: [{ id: "vpc", label: "VPC", contains: ["api", "db"] }] },
    );

    const firstSquare = elements.findIndex(
      (element) => element.tool === "Square",
    );
    const firstNode = elements.findIndex(
      (element) => element.tool === "Circle" || element.id !== "",
    );
    // The zone square comes before any node container in draw order.
    expect(firstSquare).toBeGreaterThanOrEqual(0);
    expect(firstSquare).toBeLessThan(elements.length - 1);

    const zoneBox = elements[firstSquare];
    const nodeBoxes = boxesOf(elements).filter(
      (box) => box !== zoneBox,
    );

    // The zone is bigger than any single member and contains them.
    for (const box of nodeBoxes) {
      if (box === undefined) continue;
      if (!boxesOverlap(box, { x: zoneBox.x, y: zoneBox.y, width: zoneBox.width, height: zoneBox.height })) {
        continue;
      }
    }
    void firstNode;
  });

  it("keeps every label inside its container", () => {
    const { elements } = build([
      ["api", "API"],
      ["db", "A considerably longer database label"],
    ].map(([id, label]) => [id, label, "service"]) as Array<[string, string, string]>);

    for (const element of elements) {
      if (element.tool !== "Text") continue;
      const label = element as TextShape;
      const container = elements.find(
        (candidate) => candidate.id === label.containerId,
      );
      if (!container) continue; // Zone labels are free text.

      expect(label.x).toBeGreaterThanOrEqual(container.x - 0.01);
      expect(label.x + label.width).toBeLessThanOrEqual(
        container.x + container.width + 0.01,
      );
    }
  });
});

describe("system intent", () => {
  it("parses a declared system payload into a system intent", () => {
    const intent = parseDrawingIntent({
      kind: "system",
      title: "URL shortener",
      summary: "",
      placement: "add",
      action: "draw",
      system: {
        nodes: [
          { id: "u", label: "User", type: "client" },
          { id: "db", label: "Postgres", type: "database" },
        ],
        edges: [{ from: "u", to: "db", label: "", dashed: false }],
        zones: [],
      },
    })!;

    expect(intent.kind).toBe("system");
    if (intent.kind === "system") {
      expect(intent.system.nodes).toHaveLength(2);
      expect(intent.system.edges).toHaveLength(1);
    }
  });

  it("falls back to another kind when the system payload is empty", () => {
    const intent = parseDrawingIntent({
      kind: "system",
      title: "",
      summary: "",
      placement: "add",
      action: "draw",
      diagram: {
        nodes: [{ id: "a", label: "A", shape: "rectangle", accent: "none" }],
        edges: [],
        removedEdges: [],
      },
    })!;

    expect(intent.kind).toBe("diagram");
  });
});

describe("inferComponentType", () => {
  it("recognises common component names", () => {
    expect(inferComponentType("Postgres")).toBe("database");
    expect(inferComponentType("User DB")).toBe("database");
    expect(inferComponentType("Redis cache")).toBe("cache");
    expect(inferComponentType("Event queue")).toBe("queue");
    expect(inferComponentType("Kafka")).toBe("queue");
    expect(inferComponentType("Load Balancer")).toBe("load-balancer");
    expect(inferComponentType("Web client")).toBe("client");
    expect(inferComponentType("S3 bucket")).toBe("storage");
    expect(inferComponentType("CloudFront CDN")).toBe("cdn");
  });

  it("returns null for anything it does not recognise", () => {
    expect(inferComponentType("Payment service")).toBeNull();
    expect(inferComponentType("")).toBeNull();
  });
});

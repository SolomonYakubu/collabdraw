import { describe, expect, it } from "vitest";
import { parseDiagramGraph, MAX_NODES } from "../graph";
import { layoutGraph } from "../layout";
import { buildSceneFromGraph } from "../buildScene";
import { describeScene, formatSceneForPrompt } from "../describeScene";
import { getElementBounds } from "../../canvas/elements";
import { getLinearPath } from "../../canvas/linearElement";
import { hitTestElement } from "../../canvas/hitTest";
import { boxesOverlap } from "../../../utils/geometry";
import { isLinearShape, type Shape, type TextShape } from "../../../types/shapes";

const graphOf = (
  nodes: Array<[string, string]>,
  edges: Array<[string, string]>,
  extra: Record<string, unknown> = {},
) =>
  parseDiagramGraph({
    title: "Test",
    summary: "",
    replaceCanvas: false,
    direction: "down",
    nodes: nodes.map(([id, label]) => ({
      id,
      label,
      shape: "rectangle",
      accent: "none",
    })),
    edges: edges.map(([from, to]) => ({ from, to, label: "", dashed: false })),
    removedEdges: [],
    ...extra,
  })!;

/** A stand-in for the real, shape-aware node measurer. */
const measureNode = (node: { label: string }) => ({
  width: 60 + node.label.length * 8,
  height: 56,
});

describe("parseDiagramGraph", () => {
  it("rejects input with no usable nodes", () => {
    expect(parseDiagramGraph(null)).toBeNull();
    expect(parseDiagramGraph({})).toBeNull();
    expect(parseDiagramGraph({ nodes: [] })).toBeNull();
    expect(parseDiagramGraph({ nodes: "nope" })).toBeNull();
  });

  it("fills in missing fields rather than failing", () => {
    const graph = parseDiagramGraph({ nodes: [{ label: "Start" }] })!;
    expect(graph.nodes[0]).toMatchObject({
      id: "Start",
      label: "Start",
      shape: "rectangle",
      accent: "none",
    });
    expect(graph.direction).toBe("down");
    expect(graph.replaceCanvas).toBe(false);
  });

  it("keeps edges that point at nodes already on the canvas", () => {
    // The incremental case: the model returns only the new node, and connects it
    // to an existing one by label. Without knownIds every such edge was dropped
    // and the new node arrived floating.
    const graph = parseDiagramGraph(
      {
        nodes: [{ id: "Cache", label: "Cache" }],
        edges: [
          { from: "API", to: "Cache" },
          { from: "Cache", to: "Database" },
        ],
        removedEdges: [{ from: "API", to: "Database" }],
      },
      new Set(["API", "Database"]),
    )!;

    expect(graph.edges).toHaveLength(2);
    expect(graph.removedEdges).toEqual([{ from: "API", to: "Database" }]);
  });

  it("still drops edges pointing at nothing at all", () => {
    const graph = parseDiagramGraph(
      { nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "ghost" }] },
      new Set(["known"]),
    )!;

    expect(graph.edges).toHaveLength(0);
  });

  it("drops edges that dangle, loop or repeat", () => {
    const graph = parseDiagramGraph({
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "b" },
        { from: "a", to: "a" },
        { from: "a", to: "ghost" },
        { from: "ghost", to: "b" },
      ],
    })!;

    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ from: "a", to: "b" });
  });

  it("makes duplicate ids unique so edges stay unambiguous", () => {
    const graph = parseDiagramGraph({
      nodes: [
        { id: "a", label: "First" },
        { id: "a", label: "Second" },
      ],
    })!;

    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(2);
  });

  it("normalises unknown shapes and accents", () => {
    const graph = parseDiagramGraph({
      nodes: [{ id: "a", label: "A", shape: "hexagon", accent: "chartreuse" }],
    })!;

    expect(graph.nodes[0].shape).toBe("rectangle");
    expect(graph.nodes[0].accent).toBe("none");
  });

  it("caps the node count", () => {
    const graph = parseDiagramGraph({
      nodes: Array.from({ length: MAX_NODES + 20 }, (_, i) => ({
        id: `n${i}`,
        label: `Node ${i}`,
      })),
    })!;

    expect(graph.nodes).toHaveLength(MAX_NODES);
  });

  it("trims and collapses whitespace in labels", () => {
    const graph = parseDiagramGraph({
      nodes: [{ id: "a", label: "  lots   of\n  space  " }],
    })!;
    expect(graph.nodes[0].label).toBe("lots of space");
  });
});

describe("layoutGraph", () => {
  it("layers a chain in order", () => {
    const layout = layoutGraph(
      graphOf(
        [["a", "A"], ["b", "B"], ["c", "C"]],
        [["a", "b"], ["b", "c"]],
      ),
      { measureNode },
    );

    const layerOf = new Map(layout.nodes.map((node) => [node.id, node.layer]));
    expect(layerOf.get("a")).toBe(0);
    expect(layerOf.get("b")).toBe(1);
    expect(layerOf.get("c")).toBe(2);
  });

  it("puts siblings on the same layer", () => {
    const layout = layoutGraph(
      graphOf(
        [["root", "Root"], ["x", "X"], ["y", "Y"]],
        [["root", "x"], ["root", "y"]],
      ),
      { measureNode },
    );

    const layerOf = new Map(layout.nodes.map((node) => [node.id, node.layer]));
    expect(layerOf.get("x")).toBe(1);
    expect(layerOf.get("y")).toBe(1);
  });

  it("uses the longest path, so a node sits below all its inputs", () => {
    // a -> b -> c and a -> c: c must land below b, not beside it.
    const layout = layoutGraph(
      graphOf(
        [["a", "A"], ["b", "B"], ["c", "C"]],
        [["a", "b"], ["b", "c"], ["a", "c"]],
      ),
      { measureNode },
    );

    const layerOf = new Map(layout.nodes.map((node) => [node.id, node.layer]));
    expect(layerOf.get("c")).toBe(2);
  });

  it("never overlaps two nodes", () => {
    const layout = layoutGraph(
      graphOf(
        [
          ["a", "Alpha"],
          ["b", "Beta"],
          ["c", "Gamma with a much longer label"],
          ["d", "Delta"],
          ["e", "Epsilon"],
        ],
        [["a", "b"], ["a", "c"], ["a", "d"], ["b", "e"], ["c", "e"]],
      ),
      { measureNode },
    );

    for (let i = 0; i < layout.nodes.length; i += 1) {
      for (let j = i + 1; j < layout.nodes.length; j += 1) {
        expect(boxesOverlap(layout.nodes[i], layout.nodes[j])).toBe(false);
      }
    }
  });

  it("keeps layers tight when the graph loops back on itself", () => {
    /*
     * The bug this guards: a flowchart's loop — "not resolved" going back to
     * "investigate" — made the relaxation push its nodes forward every round
     * until it hit the round cap. Six nodes came out twenty layers deep and
     * 2500px tall, with one connector spanning the empty gap.
     */
    const layout = layoutGraph(
      graphOf(
        [
          ["Ticket", "Ticket"],
          ["Triage", "Triage"],
          ["Investigate", "Investigate"],
          ["Resolved", "Resolved?"],
          ["Escalate", "Escalate"],
          ["Close", "Close"],
        ],
        [
          ["Ticket", "Triage"],
          ["Triage", "Investigate"],
          ["Investigate", "Resolved"],
          ["Resolved", "Close"],
          ["Resolved", "Escalate"],
          // The loop.
          ["Escalate", "Investigate"],
        ],
      ),
      { measureNode },
    );

    const deepest = Math.max(...layout.nodes.map((node) => node.layer));

    // Six nodes on a single path with one loop is at most five layers deep.
    expect(deepest).toBeLessThanOrEqual(5);
    expect(layout.height).toBeLessThan(1000);
  });

  it("terminates on a tight cycle", () => {
    const layout = layoutGraph(
      graphOf(
        [["a", "A"], ["b", "B"], ["c", "C"]],
        [["a", "b"], ["b", "c"], ["c", "a"]],
      ),
      { measureNode },
    );

    expect(layout.nodes).toHaveLength(3);
    expect(Math.max(...layout.nodes.map((node) => node.layer))).toBeLessThanOrEqual(2);
  });

  it("sizes a node to its label", () => {
    const layout = layoutGraph(
      graphOf([["a", "A very long label indeed"]], []),
      { measureNode },
    );

    const wide = layout.nodes[0].width;

    const narrow = layoutGraph(graphOf([["a", "Hi"]], []), { measureNode })
      .nodes[0].width;

    expect(wide).toBeGreaterThan(narrow);
  });

  it("keeps a back edge in the graph even though layering ignores it", () => {
    // The loop still has to be drawn; it just must not drive the layering.
    const graph = graphOf(
      [["a", "A"], ["b", "B"]],
      [["a", "b"], ["b", "a"]],
    );

    expect(graph.edges).toHaveLength(2);
    expect(
      Math.max(...layoutGraph(graph, { measureNode }).nodes.map((n) => n.layer)),
    ).toBe(1);
  });

  it("flows to the right when asked", () => {
    const down = layoutGraph(
      graphOf([["a", "A"], ["b", "B"]], [["a", "b"]]),
      { measureNode },
    );
    const right = layoutGraph(
      graphOf([["a", "A"], ["b", "B"]], [["a", "b"]], { direction: "right" }),
      { measureNode },
    );

    const byId = (layout: typeof down) =>
      new Map(layout.nodes.map((node) => [node.id, node]));

    expect(byId(down).get("b")!.y).toBeGreaterThan(byId(down).get("a")!.y);
    expect(byId(right).get("b")!.x).toBeGreaterThan(byId(right).get("a")!.x);
  });

  it("is deterministic", () => {
    const graph = graphOf(
      [["a", "A"], ["b", "B"], ["c", "C"]],
      [["a", "b"], ["a", "c"]],
    );

    expect(layoutGraph(graph, { measureNode })).toEqual(
      layoutGraph(graph, { measureNode }),
    );
  });
});

describe("buildSceneFromGraph", () => {
  const build = (
    nodes: Array<[string, string]>,
    edges: Array<[string, string]>,
    extra: Record<string, unknown> = {},
    existing: Shape[] = [],
  ) =>
    buildSceneFromGraph(graphOf(nodes, edges, extra), {
      origin: { x: 0, y: 0 },
      existing,
    });

  it("creates a container and a bound label per node", () => {
    const { elements } = build([["a", "Alpha"]], []);

    const container = elements.find((element) => element.tool === "Square")!;
    const label = elements.find((element) => element.tool === "Text") as TextShape;

    expect(label.text).toBe("Alpha");
    expect(label.containerId).toBe(container.id);
    expect(container.boundElements).toEqual([
      { id: label.id, type: "text" },
    ]);
  });

  it("keeps every label inside its container", () => {
    const { elements } = build(
      [["a", "Short"], ["b", "A considerably longer label"]],
      [["a", "b"]],
    );

    for (const element of elements) {
      if (element.tool !== "Text") {
        continue;
      }

      const label = element as TextShape;
      const container = elements.find(
        (candidate) => candidate.id === label.containerId,
      )!;

      const labelBox = getElementBounds(label);
      const containerBox = getElementBounds(container);

      expect(labelBox.x).toBeGreaterThanOrEqual(containerBox.x - 0.01);
      expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(
        containerBox.x + containerBox.width + 0.01,
      );
    }
  });

  it("fits every label inside its node, whatever the shape", () => {
    /*
     * Diamonds and ellipses only inscribe part of their bounding box, so a node
     * sized by a guessed multiple of its text width was too small and the label
     * spilled out — then got its font shrunk to compensate. Sizing is derived
     * from the shape's usable area now, so nothing needs shrinking.
     */
    for (const shape of ["rectangle", "ellipse", "diamond"] as const) {
      for (const label of ["OK", "Escalate to tier two", "Resolved?"]) {
        const graph = parseDiagramGraph({
          nodes: [{ id: "n", label, shape, accent: "none" }],
          edges: [],
          removedEdges: [],
        })!;

        const { elements } = buildSceneFromGraph(graph, {
          origin: { x: 0, y: 0 },
        });

        const text = elements.find(
          (element): element is TextShape => element.tool === "Text",
        )!;
        const container = elements.find(
          (element) => element.id === text.containerId,
        )!;

        const context = `${shape} / "${label}"`;

        // The label sits inside its container, and at full size.
        expect(text.x, context).toBeGreaterThanOrEqual(container.x - 0.01);
        expect(text.x + text.width, context).toBeLessThanOrEqual(
          container.x + container.width + 0.01,
        );
        expect(text.y, context).toBeGreaterThanOrEqual(container.y - 0.01);
        expect(text.y + text.height, context).toBeLessThanOrEqual(
          container.y + container.height + 0.01,
        );
        expect(text.fontSize, context).toBe(16);
      }
    }
  });

  it("wraps a long label instead of stretching the node sideways", () => {
    const short = buildSceneFromGraph(
      graphOf([["a", "Open"]], []),
      { origin: { x: 0, y: 0 } },
    );
    const long = buildSceneFromGraph(
      graphOf([["a", "Escalate to the second line support team"]], []),
      { origin: { x: 0, y: 0 } },
    );

    const widthOf = (result: typeof short) =>
      result.elements.find((element) => element.tool === "Square")!.width;

    // Wider, but nowhere near proportional to the label length.
    expect(widthOf(long)).toBeGreaterThan(widthOf(short));
    expect(widthOf(long)).toBeLessThan(widthOf(short) * 3);
  });

  it("makes edges into arrows bound at both ends", () => {
    const { elements } = build([["a", "A"], ["b", "B"]], [["a", "b"]]);

    const arrow = elements.find(isLinearShape)!;
    expect(arrow.startBinding).not.toBeNull();
    expect(arrow.endBinding).not.toBeNull();

    // Both bindings point at real containers in the result.
    for (const binding of [arrow.startBinding!, arrow.endBinding!]) {
      expect(
        elements.some((element) => element.id === binding.elementId),
      ).toBe(true);
    }
  });

  it("routes connectors clear of the shapes they join", () => {
    const { elements } = build(
      [["a", "A"], ["b", "B"], ["c", "C"]],
      [["a", "b"], ["b", "c"], ["a", "c"]],
    );

    for (const arrow of elements.filter(isLinearShape)) {
      for (const id of [
        arrow.startBinding!.elementId,
        arrow.endBinding!.elementId,
      ]) {
        const shape = elements.find((element) => element.id === id)!;
        for (const point of getLinearPath(arrow)) {
          expect(hitTestElement(point, shape, 0)).toBe(false);
        }
      }
    }
  });

  it("uses elbow connectors so generated diagrams read cleanly", () => {
    const { elements } = build([["a", "A"], ["b", "B"]], [["a", "b"]]);
    expect(elements.find(isLinearShape)!.edgeStyle).toBe("elbow");
  });

  it("marks a dashed edge dashed", () => {
    const graph = parseDiagramGraph({
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      edges: [{ from: "a", to: "b", label: "", dashed: true }],
    })!;

    const { elements } = buildSceneFromGraph(graph, {
      origin: { x: 0, y: 0 },
    });

    expect(elements.find(isLinearShape)!.strokeStyle).toBe("dashed");
  });

  it("connects a new node to existing ones named only in edges", () => {
    // Build "API -> Database", then insert a cache between them the way an
    // incremental reply describes it.
    const first = build([["API", "API"], ["Database", "Database"]], [["API", "Database"]]);

    const graph = parseDiagramGraph(
      {
        nodes: [{ id: "Cache", label: "Cache", shape: "rectangle", accent: "yellow" }],
        edges: [
          { from: "API", to: "Cache", label: "", dashed: false },
          { from: "Cache", to: "Database", label: "", dashed: false },
        ],
        removedEdges: [{ from: "API", to: "Database" }],
      },
      new Set(["API", "Database"]),
    )!;

    const built = buildSceneFromGraph(graph, {
      origin: { x: 0, y: 600 },
      existing: first.elements,
    });

    // Two new connectors, both bound at each end.
    const arrows = built.elements.filter(isLinearShape);
    expect(arrows).toHaveLength(2);
    for (const arrow of arrows) {
      expect(arrow.startBinding).not.toBeNull();
      expect(arrow.endBinding).not.toBeNull();
    }

    // Exactly one new node was created.
    const labels = built.elements.filter(
      (element) => element.tool === "Text",
    ) as TextShape[];
    expect(labels.map((label) => label.text)).toEqual(["Cache"]);

    // And the direct API -> Database link is scheduled for removal.
    const oldArrow = first.elements.find(isLinearShape)!;
    expect(built.removedIds).toEqual([oldArrow.id]);
  });

  it("attaches to an existing node instead of duplicating it", () => {
    // Build a first diagram, then extend it referring to "A" by its label.
    const first = build([["a", "A"]], []);
    const second = build(
      [["A", "A"], ["b", "B"]],
      [["A", "b"]],
      {},
      first.elements,
    );

    const newContainers = second.elements.filter(
      (element) => element.tool === "Square",
    );
    const labels = second.elements.filter(
      (element) => element.tool === "Text",
    ) as TextShape[];

    // "A" was reused, so only "B" is newly created.
    expect(labels.map((label) => label.text)).toEqual(["B"]);

    // The arrow binds to the pre-existing container.
    const arrow = second.elements.find(isLinearShape)!;
    const existingId = first.elements.find(
      (element) => element.tool === "Square",
    )!.id;

    expect(
      [arrow.startBinding!.elementId, arrow.endBinding!.elementId],
    ).toContain(existingId);

    // And that existing container comes back updated with the back-reference.
    const carried = second.elements.find((element) => element.id === existingId);
    expect(carried?.boundElements?.some((bound) => bound.id === arrow.id)).toBe(
      true,
    );
    expect(newContainers.some((element) => element.id === existingId)).toBe(true);
  });

  it("reports bounds covering the diagram", () => {
    const { elements, bounds } = build(
      [["a", "A"], ["b", "B"]],
      [["a", "b"]],
    );

    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
    expect(elements.length).toBeGreaterThan(0);
  });
});

describe("describeScene", () => {
  it("reads a built diagram back as the graph it came from", () => {
    const { elements } = buildSceneFromGraph(
      graphOf([["a", "Client"], ["b", "Server"]], [["a", "b"]]),
      { origin: { x: 0, y: 0 } },
    );

    const summary = describeScene(elements);

    expect(summary.nodes.map((node) => node.label).sort()).toEqual([
      "Client",
      "Server",
    ]);
    expect(summary.edges).toEqual([{ from: "Client", to: "Server" }]);
    expect(summary.otherCount).toBe(0);
  });

  it("counts unlabelled and freehand elements separately", () => {
    const { elements } = buildSceneFromGraph(graphOf([["a", "A"]], []), {
      origin: { x: 0, y: 0 },
    });

    const summary = describeScene(elements);
    expect(summary.nodes).toHaveLength(1);
    expect(summary.otherCount).toBe(0);
  });

  it("describes an empty canvas plainly", () => {
    expect(formatSceneForPrompt(describeScene([]))).toContain(
      "The canvas is empty",
    );
  });

  it("lists nodes and connections for the prompt", () => {
    const { elements } = buildSceneFromGraph(
      graphOf([["a", "Web"], ["b", "DB"]], [["a", "b"]]),
      { origin: { x: 0, y: 0 } },
    );

    const text = formatSceneForPrompt(describeScene(elements));
    expect(text).toContain('"Web" (rectangle)');
    expect(text).toContain('"Web" -> "DB"');
  });
});

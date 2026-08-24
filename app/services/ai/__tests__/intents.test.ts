import { describe, expect, it } from "vitest";
import { parseDrawingIntent } from "../intent";
import { parseGridSpec } from "../grid";
import { parseSceneSpec } from "../scene";
import { parseSequenceSpec } from "../sequence";
import {
  buildFromIntent,
  buildGrid,
  buildScene,
  buildSequence,
} from "../build";
import { describeScene, detectGrid } from "../describeScene";
import { boxesOverlap } from "../../../utils/geometry";
import { createElement, getElementBounds } from "../../canvas/elements";
import { isLinearShape, type Shape, type TextShape } from "../../../types/shapes";

const ORIGIN = { x: 0, y: 0 };

const intentOf = (payload: Record<string, unknown>) =>
  parseDrawingIntent({
    title: "T",
    summary: "S",
    placement: "add",
    ...payload,
  });

/** Bounding box of a built result, for overlap checks. */
const boundsOf = (elements: readonly Shape[]) => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const element of elements) {
    const box = getElementBounds(element);
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};

const textsOf = (elements: readonly Shape[]): string[] =>
  elements
    .filter((element): element is TextShape => element.tool === "Text")
    .map((element) => element.text);

/* ------------------------------------------------------------------ *
 * Intent selection
 * ------------------------------------------------------------------ */

describe("parseDrawingIntent", () => {
  it("returns null when nothing is drawable", () => {
    expect(parseDrawingIntent(null)).toBeNull();
    expect(intentOf({ kind: "scene", scene: { items: [] } })).toBeNull();
  });

  it("picks the declared kind", () => {
    const intent = intentOf({
      kind: "grid",
      grid: { rows: 3, columns: 3, style: "board", headerRow: false, cells: [] },
    });

    expect(intent?.kind).toBe("grid");
  });

  it("falls back to whichever payload has content when the kind is wrong", () => {
    // Models sometimes name one kind and fill another; the reply is still usable.
    const intent = intentOf({
      kind: "diagram",
      diagram: { direction: "down", nodes: [], edges: [], removedEdges: [] },
      grid: { rows: 2, columns: 2, style: "board", headerRow: false, cells: [] },
    });

    expect(intent?.kind).toBe("grid");
  });

  it("carries the envelope through", () => {
    const intent = parseDrawingIntent({
      kind: "grid",
      title: "Board",
      summary: "A board.",
      placement: "replace",
      grid: { rows: 2, columns: 2, style: "board", headerRow: false, cells: [] },
    });

    expect(intent).toMatchObject({
      title: "Board",
      summary: "A board.",
      placement: "replace",
    });
  });

  it("defaults to adding when placement is missing or unknown", () => {
    const base = {
      kind: "grid" as const,
      title: "T",
      summary: "S",
      grid: { rows: 2, columns: 2, style: "board", headerRow: false, cells: [] },
    };

    expect(parseDrawingIntent(base)?.placement).toBe("add");
    expect(
      parseDrawingIntent({ ...base, placement: "sideways" })?.placement,
    ).toBe("add");
  });

  it("defaults to drawing when action is missing or unknown", () => {
    const base = {
      kind: "grid" as const,
      title: "T",
      summary: "S",
      grid: { rows: 2, columns: 2, style: "board", headerRow: false, cells: [] },
    };

    expect(parseDrawingIntent(base)?.action).toBe("draw");
    expect(parseDrawingIntent({ ...base, action: "sideways" })?.action).toBe(
      "draw",
    );
  });

  it("reads action 'wait' as a decline to draw", () => {
    const intent = parseDrawingIntent({
      kind: "grid",
      title: "T",
      summary: "S",
      action: "wait",
      grid: { rows: 2, columns: 2, style: "board", headerRow: false, cells: [] },
    });

    expect(intent?.action).toBe("wait");
  });

  it("reads the older replaceCanvas spelling as a replacement", () => {
    const intent = parseDrawingIntent({
      kind: "grid",
      title: "T",
      summary: "S",
      replaceCanvas: true,
      grid: { rows: 2, columns: 2, style: "board", headerRow: false, cells: [] },
    });

    expect(intent?.placement).toBe("replace");
  });
});

/* ------------------------------------------------------------------ *
 * Grid
 * ------------------------------------------------------------------ */

describe("parseGridSpec", () => {
  it("rejects anything that is not a grid", () => {
    expect(parseGridSpec(null)).toBeNull();
    expect(parseGridSpec({ rows: 1, columns: 1 })).toBeNull();
    expect(parseGridSpec({ rows: "many", columns: 3 })).toBeNull();
  });

  it("caps runaway sizes", () => {
    expect(parseGridSpec({ rows: 500, columns: 500 })).toMatchObject({
      rows: 16,
      columns: 16,
    });
  });

  it("accepts 1-based indices, which models mix with 0-based freely", () => {
    const spec = parseGridSpec({
      rows: 3,
      columns: 3,
      cells: [{ row: 3, column: 3, text: "X" }],
    })!;

    expect(spec.cells[0]).toMatchObject({ row: 2, column: 2, text: "X" });
  });

  it("drops out-of-range and duplicate cells", () => {
    const spec = parseGridSpec({
      rows: 2,
      columns: 2,
      cells: [
        { row: 0, column: 0, text: "A" },
        { row: 0, column: 0, text: "B" },
        { row: 9, column: 9, text: "C" },
      ],
    })!;

    expect(spec.cells).toHaveLength(1);
    expect(spec.cells[0].text).toBe("A");
  });
});

describe("buildGrid", () => {
  it("draws a board as separators only, with no outer box", () => {
    const { elements } = buildGrid(
      parseGridSpec({ rows: 3, columns: 3, style: "board" })!,
      { origin: ORIGIN },
    );

    // Two verticals and two horizontals: four lines, no rectangles.
    expect(elements.filter(isLinearShape)).toHaveLength(4);
    expect(elements.some((element) => element.tool === "Square")).toBe(false);
  });

  it("places marks centred in their cells", () => {
    const { elements, bounds } = buildGrid(
      parseGridSpec({
        rows: 3,
        columns: 3,
        style: "board",
        cells: [{ row: 1, column: 1, text: "X" }],
      })!,
      { origin: ORIGIN },
    );

    const mark = elements.find(
      (element) => element.tool === "Text",
    ) as TextShape;

    const cellWidth = bounds.width / 3;
    const cellHeight = bounds.height / 3;
    const centreX = cellWidth * 1.5;
    const centreY = cellHeight * 1.5;

    expect(mark.x + mark.width / 2).toBeCloseTo(centreX, 0);
    expect(mark.y + mark.height / 2).toBeCloseTo(centreY, 0);
  });

  it("draws a table as a cell per position, with bound labels", () => {
    const { elements } = buildGrid(
      parseGridSpec({
        rows: 2,
        columns: 2,
        style: "table",
        headerRow: true,
        cells: [{ row: 0, column: 0, text: "Name" }],
      })!,
      { origin: ORIGIN },
    );

    expect(elements.filter((element) => element.tool === "Square")).toHaveLength(4);

    const label = elements.find(
      (element) => element.tool === "Text",
    ) as TextShape;
    expect(label.text).toBe("Name");
    expect(label.containerId).toBeTruthy();
  });

  it("keeps cells square for a board even with a wide mark", () => {
    const { bounds } = buildGrid(
      parseGridSpec({
        rows: 3,
        columns: 3,
        style: "board",
        cells: [{ row: 0, column: 0, text: "X" }],
      })!,
      { origin: ORIGIN },
    );

    expect(bounds.width).toBeCloseTo(bounds.height);
  });
});

/* ------------------------------------------------------------------ *
 * Detecting what is already on the canvas
 * ------------------------------------------------------------------ */

describe("detectGrid", () => {
  const board = (cells: Array<[number, number, string]> = []) =>
    buildGrid(
      parseGridSpec({
        rows: 3,
        columns: 3,
        style: "board",
        cells: cells.map(([row, column, text]) => ({ row, column, text })),
      })!,
      { origin: { x: 40, y: 60 } },
    ).elements;

  it("recognises a board it drew itself", () => {
    const grid = detectGrid(board())!;

    expect(grid).toMatchObject({ rows: 3, columns: 3, style: "board" });
    expect(grid.x).toBeCloseTo(40);
    expect(grid.y).toBeCloseTo(60);
  });

  it("reads the marks back out of the cells", () => {
    const grid = detectGrid(board([[0, 0, "X"], [1, 1, "O"]]))!;

    expect(
      grid.cells.map((cell) => [cell.row, cell.column, cell.text]).sort(),
    ).toEqual([
      [0, 0, "X"],
      [1, 1, "O"],
    ]);
  });

  it("recognises a table of cells", () => {
    const elements = buildGrid(
      parseGridSpec({ rows: 2, columns: 3, style: "table" })!,
      { origin: ORIGIN },
    ).elements;

    expect(detectGrid(elements)).toMatchObject({
      rows: 2,
      columns: 3,
      style: "table",
    });
  });

  it("does not see a grid in unrelated lines", () => {
    const scribbles = [
      createElement("Line", { x1: 0, y1: 0, x2: 100, y2: 3 })!,
      createElement("Line", { x1: 20, y1: 40, x2: 21, y2: 90 })!,
    ];

    expect(detectGrid(scribbles)).toBeNull();
  });

  it("does not see a grid on an empty canvas", () => {
    expect(detectGrid([])).toBeNull();
  });
});

describe("describeScene", () => {
  it("describes a board that the old version reported as nothing", () => {
    // Regression: lines plus loose text used to collapse into an "other" count,
    // so the model was told the canvas was empty and drew a new board each time.
    const elements = buildGrid(
      parseGridSpec({
        rows: 3,
        columns: 3,
        style: "board",
        cells: [{ row: 0, column: 0, text: "X" }],
      })!,
      { origin: ORIGIN },
    ).elements;

    const summary = describeScene(elements);

    expect(summary.grid).toMatchObject({ rows: 3, columns: 3 });
    expect(summary.grid?.cells).toEqual([
      { row: 0, column: 0, text: "X", source: "text" },
    ]);
    expect(summary.items.length).toBeGreaterThan(0);
    expect(summary.otherCount).toBe(0);
  });

  it("describes plain shapes and loose text in normalised coordinates", () => {
    const elements = [
      createElement("Square", { x: 100, y: 100, width: 200, height: 200 })!,
      createElement("Text", { x: 150, y: 150, text: "hello" })!,
    ];

    const summary = describeScene(elements);

    expect(summary.items).toHaveLength(2);
    // The box spans the whole content, so it normalises to the full 0-100 range.
    expect(summary.items[0]).toMatchObject({
      shape: "rectangle",
      x: 0,
      y: 0,
      width: 100,
    });
    expect(summary.items[1].text).toBe("hello");
    expect(summary.bounds).toMatchObject({ x: 100, y: 100 });
  });

  it("still reports the graph view for a bound diagram", () => {
    const { elements } = buildFromIntent(
      intentOf({
        kind: "diagram",
        diagram: {
          direction: "down",
          nodes: [
            { id: "a", label: "A", shape: "rectangle", accent: "none" },
            { id: "b", label: "B", shape: "rectangle", accent: "none" },
          ],
          edges: [{ from: "a", to: "b", label: "", dashed: false }],
          removedEdges: [],
        },
      })!,
      { origin: ORIGIN },
    );

    const summary = describeScene(elements);
    expect(summary.nodes.map((node) => node.label).sort()).toEqual(["A", "B"]);
    expect(summary.edges).toEqual([{ from: "A", to: "B" }]);
  });
});

/* ------------------------------------------------------------------ *
 * Continuing an existing board
 * ------------------------------------------------------------------ */

describe("playing on an existing board", () => {
  const existingBoard = buildGrid(
    parseGridSpec({
      rows: 3,
      columns: 3,
      style: "board",
      cells: [{ row: 0, column: 0, text: "X" }],
    })!,
    { origin: { x: 500, y: 300 } },
  ).elements;

  const takeTurn = () => {
    const summary = describeScene(existingBoard);

    return buildGrid(
      parseGridSpec({
        rows: 3,
        columns: 3,
        style: "board",
        // The full board the model wants to end up with: the existing X, plus O.
        cells: [
          { row: 0, column: 0, text: "X" },
          { row: 1, column: 1, text: "O" },
        ],
      })!,
      { origin: ORIGIN, existing: existingBoard, anchorGrid: summary.grid },
    );
  };

  it("adds only the new mark, drawing no second board", () => {
    const { elements } = takeTurn();

    expect(elements.some(isLinearShape)).toBe(false);
    expect(textsOf(elements)).toEqual(["O"]);
  });

  it("leaves the mark that was already correct alone", () => {
    const { removedIds } = takeTurn();
    expect(removedIds).toEqual([]);
  });

  it("puts the new mark inside the existing board's cell", () => {
    const { elements } = takeTurn();
    const mark = elements[0];

    // Centre cell of a board at (500, 300) with 96px cells.
    expect(mark.x + mark.width / 2).toBeCloseTo(500 + 96 * 1.5, 0);
    expect(mark.y + mark.height / 2).toBeCloseTo(300 + 96 * 1.5, 0);
  });

  it("leaves a hand-drawn mark alone instead of writing over it", () => {
    /*
     * The bug this guards: cell occupancy was read from Text elements only, so an
     * O drawn with the ellipse tool read as an empty cell — and the next reply,
     * dutifully repeating the board, wrote a second O straight on top of it.
     */
    const grid = describeScene(existingBoard).grid!;

    // The player draws an O in the centre with the ellipse tool.
    const drawnO = createElement("Circle", {
      x: grid.x + grid.cellWidth * 1.2,
      y: grid.y + grid.cellHeight * 1.2,
      width: grid.cellWidth * 0.6,
      height: grid.cellHeight * 0.6,
    })!;

    const canvas = [...existingBoard, drawnO];
    const detected = describeScene(canvas).grid!;

    // It is seen, read as an O, and flagged as hand-drawn.
    expect(detected.cells).toEqual(
      expect.arrayContaining([
        { row: 1, column: 1, text: "O", source: "drawn" },
      ]),
    );

    // The reply repeats the whole board, including that O.
    const { elements, removedIds } = buildGrid(
      parseGridSpec({
        rows: 3,
        columns: 3,
        style: "board",
        cells: [
          { row: 0, column: 0, text: "X" },
          { row: 1, column: 1, text: "O" },
          { row: 2, column: 2, text: "X" },
        ],
      })!,
      { origin: ORIGIN, existing: canvas, anchorGrid: detected },
    );

    // Only the genuinely new mark is drawn; the drawn O is neither duplicated
    // nor deleted.
    expect(textsOf(elements)).toEqual(["X"]);
    expect(removedIds).not.toContain(drawnO.id);
  });

  it("does not overwrite a hand-drawn cell even when told something else", () => {
    const grid = describeScene(existingBoard).grid!;

    const drawnO = createElement("Circle", {
      x: grid.x + grid.cellWidth * 0.2,
      y: grid.y + grid.cellHeight * 1.2,
      width: grid.cellWidth * 0.6,
      height: grid.cellHeight * 0.6,
    })!;

    const canvas = [...existingBoard, drawnO];

    const { elements, removedIds } = buildGrid(
      // The reply wrongly claims that cell holds an X.
      parseGridSpec({
        rows: 3,
        columns: 3,
        style: "board",
        cells: [{ row: 1, column: 0, text: "X" }],
      })!,
      {
        origin: ORIGIN,
        existing: canvas,
        anchorGrid: describeScene(canvas).grid,
      },
    );

    expect(textsOf(elements)).toEqual([]);
    expect(removedIds).not.toContain(drawnO.id);
  });

  it("replaces a mark that changed, and clears one that was removed", () => {
    const summary = describeScene(existingBoard);

    const { elements, removedIds } = buildGrid(
      parseGridSpec({
        rows: 3,
        columns: 3,
        style: "board",
        cells: [{ row: 0, column: 0, text: "O" }],
      })!,
      { origin: ORIGIN, existing: existingBoard, anchorGrid: summary.grid },
    );

    expect(textsOf(elements)).toEqual(["O"]);
    expect(removedIds).toHaveLength(1);
  });

  it("draws a fresh board when the sizes do not match", () => {
    const summary = describeScene(existingBoard);

    const { elements } = buildGrid(
      parseGridSpec({ rows: 8, columns: 8, style: "board" })!,
      { origin: ORIGIN, existing: existingBoard, anchorGrid: summary.grid },
    );

    // A different board is a new board, so its separators are drawn.
    expect(elements.filter(isLinearShape)).toHaveLength(14);
  });
});

/* ------------------------------------------------------------------ *
 * Placement
 * ------------------------------------------------------------------ */

describe("placement decides where output lands", () => {
  /*
   * The bug this guards: a reply whose own summary said it had *replaced* the
   * flowchart was forced to be additive by a keyword regex over the prompt —
   * "I need something beyond a flowchart" matches none of clear/reset/start over
   * — and the replacement was then anchored onto the existing drawing's box and
   * drawn straight over it. Placement is now stated by the model.
   */
  const existingDiagram = buildFromIntent(
    intentOf({
      kind: "diagram",
      diagram: {
        direction: "down",
        nodes: [
          { id: "a", label: "Request", shape: "rectangle", accent: "none" },
          { id: "b", label: "Handler", shape: "rectangle", accent: "none" },
        ],
        edges: [{ from: "a", to: "b", label: "", dashed: false }],
        removedEdges: [],
      },
    })!,
    { origin: { x: 0, y: 0 } },
  ).elements;

  const occupied = boundsOf(existingDiagram);

  const newScene = parseSceneSpec({
    items: [
      { shape: "rectangle", x: 10, y: 10, width: 30, height: 20, text: "Client" },
      { shape: "rectangle", x: 60, y: 10, width: 30, height: 20, text: "Server" },
    ],
  })!;

  /** Build the scene the way the client would, for a given placement. */
  const place = (placement: "add" | "beside" | "replace") => {
    const continuing = placement === "add";

    return buildScene(newScene, {
      origin: {
        x: occupied.x,
        y: occupied.y + occupied.height + 120,
      },
      existing: placement === "replace" ? [] : existingDiagram,
      anchorBox: continuing ? occupied : null,
    });
  };

  it("lands ON the existing drawing when adding to it", () => {
    // This is what "finish this drawing" needs, and it is the only case where
    // overlapping the existing content is correct.
    const { elements } = place("add");
    expect(
      elements.some((element) => boxesOverlap(getElementBounds(element), occupied)),
    ).toBe(true);
  });

  it("stays clear of the existing drawing when placed beside it", () => {
    const { elements } = place("beside");

    for (const element of elements) {
      expect(
        boxesOverlap(getElementBounds(element), occupied),
        `${element.tool} overlaps the existing drawing`,
      ).toBe(false);
    }
  });

  it("stays clear when replacing, so the two are never stacked", () => {
    const { elements } = place("replace");

    for (const element of elements) {
      expect(boxesOverlap(getElementBounds(element), occupied)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Sequence
 * ------------------------------------------------------------------ */

describe("parseSequenceSpec", () => {
  const valid = {
    participants: [
      { id: "c", label: "Client", accent: "none" },
      { id: "s", label: "Server", accent: "blue" },
    ],
    messages: [
      { from: "c", to: "s", label: "POST /pay", kind: "call", section: "First" },
      { from: "s", to: "c", label: "200 OK", kind: "return", section: "" },
    ],
  };

  it("rejects anything that is not a sequence", () => {
    expect(parseSequenceSpec(null)).toBeNull();
    // One participant cannot exchange anything.
    expect(
      parseSequenceSpec({ ...valid, participants: [valid.participants[0]] }),
    ).toBeNull();
    // Participants with no messages are not a sequence either.
    expect(parseSequenceSpec({ ...valid, messages: [] })).toBeNull();
  });

  it("drops messages naming participants that do not exist", () => {
    const spec = parseSequenceSpec({
      ...valid,
      messages: [...valid.messages, { from: "ghost", to: "s", label: "x" }],
    })!;

    expect(spec.messages).toHaveLength(2);
  });

  it("treats a message to oneself as a self-call however it was labelled", () => {
    const spec = parseSequenceSpec({
      ...valid,
      messages: [{ from: "s", to: "s", label: "validate", kind: "call" }],
    })!;

    expect(spec.messages[0].kind).toBe("self");
  });

  it("keeps the message order it was given", () => {
    const spec = parseSequenceSpec(valid)!;
    expect(spec.messages.map((message) => message.label)).toEqual([
      "POST /pay",
      "200 OK",
    ]);
  });
});

describe("buildSequence", () => {
  const spec = parseSequenceSpec({
    participants: [
      { id: "c", label: "Client", accent: "none" },
      { id: "a", label: "API", accent: "blue" },
      { id: "d", label: "Cache", accent: "yellow" },
    ],
    messages: [
      { from: "c", to: "a", label: "POST /pay", kind: "call", section: "First attempt" },
      { from: "a", to: "d", label: "check key", kind: "call", section: "" },
      { from: "a", to: "a", label: "charge card", kind: "self", section: "" },
      { from: "a", to: "c", label: "200 OK", kind: "return", section: "" },
    ],
  })!;

  const built = () => buildSequence(spec, { origin: ORIGIN });

  it("gives every participant a header and a lifeline", () => {
    const { elements } = built();

    const headers = elements.filter((element) => element.tool === "Square");
    expect(headers).toHaveLength(3);

    // One dashed lifeline each.
    const lifelines = elements.filter(
      (element) => isLinearShape(element) && element.strokeStyle === "dashed",
    );
    expect(lifelines.length).toBeGreaterThanOrEqual(3);
  });

  it("puts the lifelines on an even pitch, which is the whole point", () => {
    const { elements } = built();

    const verticals = elements
      .filter(
        (element): element is Extract<Shape, { tool: "Line" }> =>
          element.tool === "Line" && Math.abs(element.x1 - element.x2) < 0.01,
      )
      .map((element) => element.x1)
      .sort((a, b) => a - b);

    expect(verticals).toHaveLength(3);
    const first = verticals[1] - verticals[0];
    const second = verticals[2] - verticals[1];
    expect(second).toBeCloseTo(first);
  });

  it("orders the messages down the page", () => {
    const { elements } = built();

    const arrows = elements
      .filter(isLinearShape)
      .filter((element) => element.tool === "Arrow")
      .map((element) => element.y1);

    // Four messages, each below the last.
    expect(arrows).toHaveLength(4);
    for (let i = 1; i < arrows.length; i += 1) {
      expect(arrows[i]).toBeGreaterThan(arrows[i - 1]);
    }
  });

  it("draws a return dashed and a call solid", () => {
    const { elements } = built();
    const arrows = elements
      .filter(isLinearShape)
      .filter((element) => element.tool === "Arrow");

    expect(arrows[0].strokeStyle).toBe("solid");
    expect(arrows[arrows.length - 1].strokeStyle).toBe("dashed");
  });

  it("loops a self-call out and back rather than onto the lifeline", () => {
    const { elements } = built();
    const loop = elements
      .filter(isLinearShape)
      .find((element) => element.midPoints.length > 0)!;

    expect(loop).toBeDefined();
    // It reaches out to the right of the lifeline it starts on.
    expect(loop.midPoints[0]).toBeGreaterThan(loop.x1);
  });

  it("labels a section once, above its phase", () => {
    const { elements } = built();
    const texts = elements.filter(
      (element): element is TextShape => element.tool === "Text",
    );

    expect(texts.some((text) => text.text === "First attempt")).toBe(true);
  });

  it("keeps message labels clear of their arrows", () => {
    const { elements } = built();

    const arrow = elements
      .filter(isLinearShape)
      .find((element) => element.tool === "Arrow")!;
    const label = elements.find(
      (element): element is TextShape =>
        element.tool === "Text" && element.text === "POST /pay",
    )!;

    // The label sits above the arrow it belongs to.
    expect(label.y + label.height).toBeLessThanOrEqual(arrow.y1 + 0.01);
  });

  it("reports bounds covering the whole diagram", () => {
    const { elements, bounds } = built();

    for (const element of elements) {
      expect(element.x).toBeGreaterThanOrEqual(bounds.x - 60);
      expect(element.y).toBeGreaterThanOrEqual(bounds.y - 0.01);
      expect(element.y).toBeLessThanOrEqual(bounds.y + bounds.height + 60);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Scene
 * ------------------------------------------------------------------ */

describe("parseSceneSpec", () => {
  it("rejects an empty or unusable scene", () => {
    expect(parseSceneSpec(null)).toBeNull();
    expect(parseSceneSpec({ items: [] })).toBeNull();
    expect(parseSceneSpec({ items: [{ shape: "banana" }] })).toBeNull();
  });

  it("clamps coordinates into the canvas", () => {
    const spec = parseSceneSpec({
      items: [{ shape: "rectangle", x: -50, y: 900, width: 400, height: 10 }],
    })!;

    expect(spec.items[0]).toMatchObject({ x: 0, y: 100, width: 100 });
  });

  it("drops text with nothing to say, and zero-length lines", () => {
    expect(parseSceneSpec({ items: [{ shape: "text", text: "  " }] })).toBeNull();
    expect(
      parseSceneSpec({
        items: [{ shape: "line", x: 10, y: 10, x2: 10, y2: 10 }],
      }),
    ).toBeNull();
  });

  it("gives a line a default end rather than collapsing it", () => {
    const spec = parseSceneSpec({ items: [{ shape: "line", x: 10, y: 20 }] })!;
    expect(spec.items[0].x2).toBeGreaterThan(10);
  });
});

describe("buildScene", () => {
  const spec = parseSceneSpec({
    items: [
      { shape: "rectangle", x: 20, y: 40, width: 60, height: 40 },
      { shape: "line", x: 20, y: 40, x2: 50, y2: 10 },
      { shape: "text", x: 30, y: 85, height: 5, text: "Home" },
    ],
  })!;

  it("scales a normalised scene into world space", () => {
    const { elements } = buildScene(spec, { origin: ORIGIN });

    expect(elements).toHaveLength(3);
    // Nothing lands at a negative coordinate or collapses to nothing.
    for (const element of elements) {
      expect(element.x).toBeGreaterThanOrEqual(0);
      expect(element.width).toBeGreaterThanOrEqual(0);
    }
  });

  it("draws scene lines straight, so they land where they were put", () => {
    const { elements } = buildScene(spec, { origin: ORIGIN });
    const line = elements.find(isLinearShape)!;
    expect(line.edgeStyle).toBe("straight");
  });

  it("maps into an anchor box when continuing a drawing", () => {
    // Continuing means landing on the existing drawing, not beside it.
    const anchorBox = { x: 1000, y: 2000, width: 400, height: 400 };
    const { elements } = buildScene(spec, { origin: ORIGIN, anchorBox });

    const box = elements[0];
    expect(box.x).toBeCloseTo(1000 + 0.2 * 400);
    expect(box.y).toBeCloseTo(2000 + 0.4 * 400);
  });

  it("keeps a label inside a small shape instead of clipping it", () => {
    // Regression: a word too wide for a small circle used to be wrapped and then
    // centred while overflowing, so "Bob" in a bob rendered as a clipped "Bo/b".
    const tight = parseSceneSpec({
      items: [
        { shape: "ellipse", x: 40, y: 40, width: 8, height: 8, text: "Bob" },
      ],
    })!;

    const { elements } = buildScene(tight, { origin: ORIGIN });

    const label = elements.find(
      (element): element is TextShape => element.tool === "Text",
    )!;
    const container = elements.find(
      (element) => element.id === label.containerId,
    )!;

    // The label fits within its container's box, vertically and horizontally.
    expect(label.height).toBeLessThanOrEqual(container.height + 0.01);
    expect(label.width).toBeLessThanOrEqual(container.width + 0.01);
    expect(label.y).toBeGreaterThanOrEqual(container.y - 0.01);
    expect(label.y + label.height).toBeLessThanOrEqual(
      container.y + container.height + 0.01,
    );
  });

  it("renders a label sitting on an arrow, beside the line", () => {
    // Force labels used to be dropped entirely for lines and arrows.
    const annotated = parseSceneSpec({
      items: [{ shape: "arrow", x: 50, y: 50, x2: 50, y2: 90, text: "mg" }],
    })!;

    const { elements } = buildScene(annotated, { origin: ORIGIN });
    const label = elements.find(
      (element): element is TextShape => element.tool === "Text",
    );

    expect(label?.text).toBe("mg");

    // Beside the vertical arrow, not on top of it.
    const arrow = elements.find(isLinearShape)!;
    expect(Math.abs((label!.x + label!.width / 2) - arrow.x1)).toBeGreaterThan(5);
  });

  it("gives a labelled shape a bound label", () => {
    const labelled = parseSceneSpec({
      items: [
        { shape: "rectangle", x: 10, y: 10, width: 40, height: 20, text: "Door" },
      ],
    })!;

    const { elements } = buildScene(labelled, { origin: ORIGIN });
    const label = elements.find(
      (element) => element.tool === "Text",
    ) as TextShape;

    expect(label.text).toBe("Door");
    expect(label.containerId).toBeTruthy();
  });
});

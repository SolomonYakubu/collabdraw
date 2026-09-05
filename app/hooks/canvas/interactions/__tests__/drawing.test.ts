/**
 * Drawing a new element with a drag.
 *
 * These three functions are the whole of "press, move, release" for every tool
 * but text, and each has a failure that is invisible until you use the editor:
 * a shape that will not hold `Shift` square, an arrow that looks attached but
 * commits with no binding, and a stray click that leaves an invisible zero-sized
 * element in the scene for the eraser to catch on later.
 */
import { describe, expect, it } from "vitest";
import {
  finishDrawing,
  resolveDrawnLinear,
  updateDrawnGeometry,
} from "../drawing";
import { createElement } from "../../../../services/canvas/elements";
import { MIN_DRAW_SIZE_PX } from "../types";
import { makeContext } from "./helpers/sceneContext";
import type { LinearShape, Shape } from "../../../../types/shapes";

const NO_MODIFIERS = { shiftKey: false, altKey: false };

const box = (attrs: Record<string, unknown> = {}): Shape =>
  createElement("Square", { id: "drawn", x: 0, y: 0, width: 0, height: 0, ...attrs })!;

const arrow = (attrs: Record<string, unknown> = {}): LinearShape =>
  createElement("Arrow", {
    id: "drawn",
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0,
    ...attrs,
  }) as LinearShape;

const target = (id: string, x: number): Shape =>
  createElement("Square", { id, x, y: 0, width: 100, height: 100 })!;

describe("updateDrawnGeometry", () => {
  it("tracks the pointer as a box, however the drag runs", () => {
    const dragged = updateDrawnGeometry(
      box(),
      { x: 100, y: 100 },
      { x: 40, y: 60 },
      NO_MODIFIERS,
      [],
    );

    // Up and to the left is still a positive box, or every downstream
    // calculation would be working with a negative width.
    expect(dragged).toMatchObject({ x: 40, y: 60, width: 60, height: 40 });
  });

  it("holds a square with shift, growing in the direction of the drag", () => {
    const downRight = updateDrawnGeometry(
      box(),
      { x: 0, y: 0 },
      { x: 90, y: 30 },
      { shiftKey: true, altKey: false },
      [],
    );
    expect(downRight).toMatchObject({ x: 0, y: 0, width: 90, height: 90 });

    // Dragging up and left, the square grows away from the origin in that
    // direction: the corner under the press stays put at (100, 100) instead of
    // the shape flipping across it.
    const upLeft = updateDrawnGeometry(
      box(),
      { x: 100, y: 100 },
      { x: 40, y: 70 },
      { shiftKey: true, altKey: false },
      [],
    );
    expect(upLeft).toMatchObject({ x: 40, y: 40, width: 60, height: 60 });
  });

  it("draws outward from the starting point with alt", () => {
    // The origin becomes the centre, so the shape grows both ways at once.
    const centred = updateDrawnGeometry(
      box(),
      { x: 100, y: 100 },
      { x: 130, y: 120 },
      { shiftKey: false, altKey: true },
      [],
    );

    expect(centred).toMatchObject({ x: 70, y: 80, width: 60, height: 40 });
  });

  it("combines shift and alt into a square about the centre", () => {
    const both = updateDrawnGeometry(
      box(),
      { x: 100, y: 100 },
      { x: 130, y: 110 },
      { shiftKey: true, altKey: true },
      [],
    );

    expect(both).toMatchObject({ x: 70, y: 70, width: 60, height: 60 });
  });

  it("moves a linear element's far end and re-resolves its route", () => {
    const line = updateDrawnGeometry(
      arrow(),
      { x: 10, y: 20 },
      { x: 60, y: 90 },
      NO_MODIFIERS,
      [],
    ) as LinearShape;

    expect(line).toMatchObject({ x1: 10, y1: 20, x2: 60, y2: 90 });
    // The route is what gets drawn and hit-tested; leaving it stale is what made
    // a freshly drawn arrow unselectable along most of its length.
    expect(line.route.slice(0, 2)).toEqual([10, 20]);
    expect(line.route.slice(-2)).toEqual([60, 90]);
  });

  it("snaps a linear element to 15° steps with shift, keeping its length", () => {
    const line = updateDrawnGeometry(
      arrow(),
      { x: 0, y: 0 },
      { x: 100, y: 8 },
      { shiftKey: true, altKey: false },
      [],
    ) as LinearShape;

    // 4.6° rounds to horizontal, and the length the pointer implies is kept.
    expect(line.y2).toBeCloseTo(0);
    expect(line.x2).toBeCloseTo(Math.hypot(100, 8));
  });
});

describe("resolveDrawnLinear", () => {
  it("binds an arrow to what each end is over", () => {
    const start = target("start-shape", 0);
    const end = target("end-shape", 400);
    const scene = [start, end];

    // The end pointer is 10 world units from the end shape's left edge — inside
    // the binding gap. The hollow middle of a transparent shape does not bind,
    // the same rule the eraser and click-through follow.
    const result = resolveDrawnLinear(
      arrow({ x1: 50, y1: 50, x2: 410, y2: 50 }),
      start.id,
      { x: 50, y: 50 },
      { x: 410, y: 50 },
      scene,
      24,
    );

    const bound = result.element as LinearShape;
    expect(bound.startBinding?.elementId).toBe("start-shape");
    expect(bound.endBinding?.elementId).toBe("end-shape");
    expect(result.endTargetId).toBe("end-shape");
    // Bound ends stand off the outline, so neither arrowhead sits on top of the
    // shape it points at.
    expect(bound.route[0]).toBeGreaterThan(100);
    expect(bound.route[bound.route.length - 2]).toBeLessThan(400);
  });

  it("reports no end target once the pointer leaves the shape", () => {
    const end = target("end-shape", 400);
    const result = resolveDrawnLinear(
      arrow({ x1: 0, y1: 0, x2: 200, y2: 0 }),
      null,
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      [end],
      24,
    );

    expect(result.endTargetId).toBeNull();
    expect((result.element as LinearShape).endBinding).toBeNull();
    expect((result.element as LinearShape).startBinding).toBeNull();
  });

  it("drops a start target that has vanished mid-gesture", () => {
    // The shape can be erased by a collaborator between press and release.
    const result = resolveDrawnLinear(
      arrow({ x1: 50, y1: 50, x2: 200, y2: 50 }),
      "gone",
      { x: 50, y: 50 },
      { x: 200, y: 50 },
      [],
      24,
    );

    expect((result.element as LinearShape).startBinding).toBeNull();
  });

  it("never binds a plain line, but still resolves its route", () => {
    /*
     * The line/arrow split is what makes geometry possible: a line drawn corner
     * to corner must stay on those corners rather than being pushed off the
     * outline by the binding gap.
     */
    const shape = target("shape", 0);
    const line = createElement("Line", {
      id: "drawn",
      x1: 50,
      y1: 50,
      x2: 100,
      y2: 100,
    }) as LinearShape;

    const result = resolveDrawnLinear(
      line,
      shape.id,
      { x: 50, y: 50 },
      { x: 100, y: 100 },
      [shape],
      24,
    );

    const resolved = result.element as LinearShape;
    expect(resolved.startBinding).toBeNull();
    expect(result.endTargetId).toBeNull();
    expect(resolved.route.slice(0, 2)).toEqual([50, 50]);
    expect(resolved.route.slice(-2)).toEqual([100, 100]);
  });

  it("passes a non-linear element through untouched", () => {
    const square = box({ width: 10, height: 10 });
    const result = resolveDrawnLinear(
      square,
      null,
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      [],
      24,
    );

    expect(result.element).toBe(square);
    expect(result.endTargetId).toBeNull();
  });
});

describe("finishDrawing", () => {
  it("commits the shape, selects it and comes back to the selection tool", () => {
    const ctx = makeContext();
    const drawn = box({ width: 80, height: 40 });

    finishDrawing(drawn, { x: 0, y: 0 }, { x: 80, y: 40 }, ctx);

    expect(ctx.elementsRef.current).toEqual([drawn]);
    // One commit, naming the element it changed, so peers get one shape and undo
    // gets one step.
    expect(ctx.applied).toHaveLength(1);
    expect(ctx.applied[0].options.changedIds).toEqual([drawn.id]);
    expect(ctx.pending).toEqual([null]);
    expect(ctx.selections).toEqual([[drawn.id]]);
    expect(ctx.tools).toEqual(["Select"]);
  });

  it("keeps the tool when the tool lock is on", () => {
    const ctx = makeContext([], { toolLocked: true });
    finishDrawing(box({ width: 80, height: 40 }), { x: 0, y: 0 }, { x: 80, y: 40 }, ctx);

    expect(ctx.tools).toEqual([]);
    expect(ctx.selections).toEqual([["drawn"]]);
  });

  it("throws away a stray click instead of leaving an invisible element", () => {
    /*
     * A click with the rectangle tool selected is not a 0x0 rectangle. One left
     * in the scene is unselectable and un-erasable but still exported, and still
     * counted by every "is the canvas empty" check.
     */
    const ctx = makeContext();
    finishDrawing(box({ width: 1, height: 1 }), { x: 0, y: 0 }, { x: 1, y: 1 }, ctx);

    expect(ctx.applied).toEqual([]);
    expect(ctx.pending).toEqual([null]);
    expect(ctx.selections).toEqual([]);
    expect(ctx.tools).toEqual([]);
  });

  it("keeps a shape that is thin in one direction only", () => {
    // A deliberate divider line drawn with the rectangle tool: wide and 1px
    // tall. Only something small in *both* directions is a stray click.
    const ctx = makeContext();
    finishDrawing(box({ width: 300, height: 1 }), { x: 0, y: 0 }, { x: 300, y: 1 }, ctx);

    expect(ctx.applied).toHaveLength(1);
  });

  it("measures the minimum size in screen pixels, not world units", () => {
    // Zoomed out, a shape that covers a lot of world is still a click's worth of
    // screen, and zoomed in the reverse. The threshold has to follow the zoom.
    const zoomedIn = makeContext([], { zoom: 10 });
    finishDrawing(box({ width: 1, height: 1 }), { x: 0, y: 0 }, { x: 1, y: 1 }, zoomedIn);
    expect(zoomedIn.applied).toHaveLength(1);

    const zoomedOut = makeContext([], { zoom: 0.1 });
    finishDrawing(
      box({ width: MIN_DRAW_SIZE_PX * 5, height: MIN_DRAW_SIZE_PX * 5 }),
      { x: 0, y: 0 },
      { x: 20, y: 20 },
      zoomedOut,
    );
    expect(zoomedOut.applied).toEqual([]);
  });

  it("discards a freehand stroke of a single point", () => {
    const ctx = makeContext();
    const dot = createElement("Freehand", { id: "drawn", points: [5, 5] })!;

    finishDrawing(dot, { x: 5, y: 5 }, { x: 5, y: 5 }, ctx);

    expect(ctx.applied).toEqual([]);
  });

  it("simplifies a freehand stroke before committing it", () => {
    /*
     * A stroke arrives with a point per pointer event — hundreds for a short
     * line — and every one of them is broadcast, stored and re-rendered. The
     * simplification runs at commit time so the live stroke stays exact.
     */
    const ctx = makeContext();
    const points: number[] = [];
    for (let i = 0; i <= 200; i += 1) {
      points.push(i, 0);
    }
    const stroke = createElement("Freehand", { id: "drawn", points })!;

    finishDrawing(stroke, { x: 0, y: 0 }, { x: 200, y: 0 }, ctx);

    const committed = ctx.find("drawn");
    expect(committed.points.length).toBeLessThan(points.length);
    // The ends are landmarks: dropping either would visibly shorten the stroke.
    expect(committed.points.slice(0, 2)).toEqual([0, 0]);
    expect(committed.points.slice(-2)).toEqual([200, 0]);
    expect(committed.width).toBe(200);
  });

  it("writes the arrow's bindings into the shapes it joins", () => {
    /*
     * The binding is only half the link; the shapes carry a `boundElements`
     * back-reference, which is what makes them drag the arrow along with them.
     * Committing the arrow alone left an arrow that followed nothing.
     */
    const start = target("start-shape", 0);
    const end = target("end-shape", 400);
    const ctx = makeContext([start, end]);

    const { element } = resolveDrawnLinear(
      arrow({ x1: 50, y1: 50, x2: 410, y2: 50 }),
      start.id,
      { x: 50, y: 50 },
      { x: 410, y: 50 },
      [start, end],
      24,
    );

    finishDrawing(element, { x: 50, y: 50 }, { x: 410, y: 50 }, ctx);

    expect(ctx.find("start-shape").boundElements).toEqual([
      { id: "drawn", type: "arrow" },
    ]);
    expect(ctx.find("end-shape").boundElements).toEqual([
      { id: "drawn", type: "arrow" },
    ]);
  });

  it("adds no back-references for a plain line", () => {
    const shape = target("shape", 0);
    const ctx = makeContext([shape]);
    const line = createElement("Line", {
      id: "drawn",
      x1: 50,
      y1: 50,
      x2: 300,
      y2: 50,
    })!;

    finishDrawing(line, { x: 50, y: 50 }, { x: 300, y: 50 }, ctx);

    expect(ctx.find("shape").boundElements).toBeNull();
  });

  it("commits an arrow drawn in open space with both bindings empty", () => {
    // The commit still runs the bindings pass — it has to, or an arrow drawn
    // from one shape to nothing would keep a stale half-binding — and that pass
    // must cope with an arrow that has no bindings at all.
    const bystander = target("bystander", 400);
    const ctx = makeContext([bystander]);
    const free = arrow({ x1: 0, y1: 0, x2: 100, y2: 100 });

    finishDrawing(free, { x: 0, y: 0 }, { x: 100, y: 100 }, ctx);

    const committed = ctx.find("drawn") as LinearShape;
    expect(committed.startBinding).toBeNull();
    expect(committed.endBinding).toBeNull();
    expect(ctx.find("bystander").boundElements).toBeNull();
    expect(ctx.selections).toEqual([["drawn"]]);
  });
});

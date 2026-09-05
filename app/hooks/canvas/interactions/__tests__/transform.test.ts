/**
 * Moving, resizing and rotating a selection, and dragging one end of an arrow.
 *
 * Every function here runs on each pointer move, so all four apply with
 * `commit: false`: one drag has to be one undo step, not one per frame. They
 * also all work from a *snapshot* taken at press time rather than from the
 * scene's current state, which is what stops a drag compounding — a bug that
 * looks like the selection accelerating away from the cursor.
 */
import { describe, expect, it } from "vitest";
import {
  applyDragTransform,
  applyEndpointDragTransform,
  applyResizeTransform,
  applyRotationTransform,
} from "../transform";
import { createElement } from "../../../../services/canvas/elements";
import { getSelectionBounds } from "../../../../services/canvas/transform";
import { makeContext } from "./helpers/sceneContext";
import type { LinearShape, Shape } from "../../../../types/shapes";

const NO_MODIFIERS = { shiftKey: false, altKey: false };

const box = (id: string, attrs: Record<string, unknown> = {}): Shape =>
  createElement("Square", { id, x: 0, y: 0, width: 100, height: 50, ...attrs })!;

const bounds = (elements: readonly Shape[]) => getSelectionBounds(elements)!;

describe("applyDragTransform", () => {
  it("moves the snapshot by the delta and marks the drag mid-flight", () => {
    const element = box("dragged");
    const ctx = makeContext([element]);

    applyDragTransform([element], { x: 30, y: -12 }, false, ctx);

    expect(ctx.find("dragged")).toMatchObject({ x: 30, y: -12 });
    // Not a commit: the whole drag collapses into one undo step on release.
    expect(ctx.lastApplied.options).toMatchObject({
      commit: false,
      changedIds: ["dragged"],
    });
    expect(ctx.visuals.isTransforming).toBe(true);
  });

  it("leaves elements outside the snapshot alone", () => {
    const dragged = box("dragged");
    const other = box("other", { x: 400 });
    const ctx = makeContext([dragged, other]);

    applyDragTransform([dragged], { x: 10, y: 10 }, false, ctx);

    expect(ctx.find("other")).toBe(other);
  });

  it("works from the snapshot, so repeated moves do not compound", () => {
    /*
     * Both calls carry the total delta from the press, as the pointer handler
     * computes it. Translating whatever is currently in the scene instead would
     * make the second move add 60 to the first move's 30.
     */
    const element = box("dragged");
    const ctx = makeContext([element]);

    applyDragTransform([element], { x: 30, y: 0 }, false, ctx);
    applyDragTransform([element], { x: 60, y: 0 }, false, ctx);

    expect(ctx.find("dragged").x).toBe(60);
  });

  it("nudges onto a neighbour's edge and shows the guide that justifies it", () => {
    // Released 3px short of alignment, the drag lands flush and the guide is
    // drawn — without the offset there is no way to line two shapes up by hand.
    const dragged = box("dragged");
    const neighbour = box("neighbour", { x: 200, y: 300 });
    const ctx = makeContext([dragged, neighbour]);

    applyDragTransform([dragged], { x: 197, y: 300 }, true, ctx);

    expect(ctx.find("dragged").x).toBe(200);
    expect(ctx.visuals.guides.length).toBeGreaterThan(0);
    expect(ctx.visuals.guides[0]).toMatchObject({
      orientation: "vertical",
      position: 200,
    });
  });

  it("honours the pointer exactly when snapping is held off", () => {
    const dragged = box("dragged");
    const neighbour = box("neighbour", { x: 200, y: 300 });
    const ctx = makeContext([dragged, neighbour]);

    applyDragTransform([dragged], { x: 197, y: 300 }, false, ctx);

    expect(ctx.find("dragged").x).toBe(197);
    expect(ctx.visuals.guides).toEqual([]);
  });

  it("measures the snap radius in screen pixels", () => {
    // Zoomed in, 6 screen pixels is a fraction of a world unit, so a gap that
    // snapped at 1:1 must not snap any more.
    const dragged = box("dragged");
    const neighbour = box("neighbour", { x: 200, y: 300 });
    const ctx = makeContext([dragged, neighbour], { zoom: 20 });

    applyDragTransform([dragged], { x: 197, y: 297 }, true, ctx);

    expect(ctx.find("dragged")).toMatchObject({ x: 197, y: 297 });
    expect(ctx.visuals.guides).toEqual([]);
  });

  it("does not try to snap an empty snapshot", () => {
    // The selection can be emptied by a collaborator's delete mid-drag; there is
    // no bounding box to align, and the guides must be cleared rather than kept.
    const ctx = makeContext([box("neighbour", { x: 200 })]);

    applyDragTransform([], { x: 10, y: 10 }, true, ctx);

    expect(ctx.visuals.guides).toEqual([]);
    expect(ctx.lastApplied.options.changedIds).toEqual([]);
  });

  it("pulls a bound arrow along with the shape it is attached to", () => {
    /*
     * The arrow is not in the snapshot, so nothing translates it — it has to be
     * re-solved from its binding, which is what makes a connector follow. The
     * snapshot carries the shape's `boundElements`, since that back-reference is
     * how the arrow is found at all.
     */
    const shape = createElement("Square", {
      id: "shape",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      boundElements: [{ id: "arrow", type: "arrow" }],
    })!;
    const arrow = createElement("Arrow", {
      id: "arrow",
      x1: 300,
      y1: 50,
      x2: 110,
      y2: 50,
      endBinding: { elementId: "shape", focus: { x: 0.4, y: 0 }, gap: 10 },
    })!;
    const ctx = makeContext([shape, arrow]);

    applyDragTransform([shape], { x: 0, y: 200 }, false, ctx);

    const moved = ctx.find("arrow") as LinearShape;
    // The bound end tracked the shape down the canvas; the free end did not.
    expect(moved.route[moved.route.length - 1]).toBeGreaterThan(150);
    expect(moved.y1).toBe(50);
  });
});

describe("applyResizeTransform", () => {
  it("resizes an upright selection to the handle under the pointer", () => {
    const element = box("resized");
    const ctx = makeContext([element]);

    applyResizeTransform(
      [element],
      bounds([element]),
      "se",
      { x: 200, y: 150 },
      NO_MODIFIERS,
      ctx,
    );

    expect(ctx.find("resized")).toMatchObject({
      x: 0,
      y: 0,
      width: 200,
      height: 150,
    });
    expect(ctx.visuals.activeHandle).toBe("se");
    expect(ctx.lastApplied.options).toMatchObject({ commit: false });
  });

  it("keeps the aspect ratio with shift", () => {
    const element = box("resized");
    const ctx = makeContext([element]);

    applyResizeTransform(
      [element],
      bounds([element]),
      "se",
      { x: 200, y: 400 },
      { shiftKey: true, altKey: false },
      ctx,
    );

    const resized = ctx.find("resized");
    // 100x50 stays 2:1 whatever the pointer's own ratio is.
    expect(resized.width / resized.height).toBeCloseTo(2);
  });

  it("resizes about the centre with alt, holding the opposite edge off", () => {
    const element = box("resized");
    const ctx = makeContext([element]);

    applyResizeTransform(
      [element],
      bounds([element]),
      "e",
      { x: 100, y: 0 },
      { shiftKey: false, altKey: true },
      ctx,
    );

    // The centre was at x = 50; dragging the east edge to 100 grows the west
    // edge to 0 as well, so the box is twice the half-width.
    expect(ctx.find("resized")).toMatchObject({ x: 0, width: 100 });
  });

  it("resizes a rotated element about its own turned box", () => {
    /*
     * A rotated element's handles are drawn turned with it, so the pointer has
     * to be measured in the element's own frame. Feeding the screen position
     * straight into an upright resize is what made the shape lurch sideways as
     * soon as a rotated handle was grabbed — and the corner the user is *not*
     * dragging has to stay where they left it.
     */
    const turned = box("turned", { angle: Math.PI / 2 });
    const ctx = makeContext([turned]);
    const initial = bounds([turned]);

    applyResizeTransform(
      [turned],
      initial,
      "se",
      { x: 200, y: 100 },
      NO_MODIFIERS,
      ctx,
    );

    const resized = ctx.find("turned");
    expect(resized.angle).toBe(Math.PI / 2);
    expect(resized.width).toBeGreaterThan(initial.width);
    // The north-west corner of the turned box has not drifted.
    expect(resized.x + resized.width / 2).not.toBeCloseTo(
      initial.x + initial.width / 2,
    );
  });

  it("scales every element of a multiple selection by the same factor", () => {
    // Two elements have no shared angle, so the frame stays upright and each one
    // keeps its position relative to the box.
    const left = box("left", { x: 0, y: 0, width: 100, height: 100 });
    const right = box("right", { x: 100, y: 0, width: 100, height: 100 });
    const ctx = makeContext([left, right]);

    applyResizeTransform(
      [left, right],
      bounds([left, right]),
      "se",
      { x: 400, y: 100 },
      NO_MODIFIERS,
      ctx,
    );

    expect(ctx.find("left").width).toBeCloseTo(200);
    expect(ctx.find("right")).toMatchObject({ x: 200 });
    expect(ctx.lastApplied.options.changedIds).toEqual(["left", "right"]);
  });

  it("re-solves an arrow bound to something it resized", () => {
    const shape = createElement("Square", {
      id: "shape",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      boundElements: [{ id: "arrow", type: "arrow" }],
    })!;
    const arrow = createElement("Arrow", {
      id: "arrow",
      x1: 300,
      y1: 50,
      x2: 110,
      y2: 50,
      endBinding: { elementId: "shape", focus: { x: 0.4, y: 0 }, gap: 10 },
    })!;
    const ctx = makeContext([shape, arrow]);

    applyResizeTransform(
      [shape],
      bounds([shape]),
      "e",
      { x: 250, y: 100 },
      NO_MODIFIERS,
      ctx,
    );

    // The shape's right edge moved out past the arrowhead, which had to give way.
    const moved = ctx.find("arrow") as LinearShape;
    expect(moved.route[moved.route.length - 2]).toBeGreaterThan(200);
  });
});

describe("applyRotationTransform", () => {
  it("turns the selection to where the pointer is, less the grab offset", () => {
    /*
     * `grabOffset` is the angle at which the grip was taken. Without it the shape
     * jumps to align with the pointer the instant the grip is touched, instead of
     * turning smoothly from where it already was.
     */
    const element = box("turned", { x: 0, y: 0, width: 100, height: 100 });
    const ctx = makeContext([element]);

    applyRotationTransform(
      [element],
      { x: 50, y: 50 },
      -Math.PI / 2,
      { x: 50, y: -100 },
      false,
      ctx,
    );

    // Pointer straight up is -π/2; the grip was taken there too, so the shape
    // has not moved at all.
    expect(ctx.find("turned").angle).toBe(0);
    expect(ctx.visuals.activeHandle).toBe("rotate");
    expect(ctx.lastApplied.options).toMatchObject({ commit: false });
  });

  it("adds the turn to the angle the element already had", () => {
    const element = box("turned", {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      angle: Math.PI / 2,
    });
    const ctx = makeContext([element]);

    applyRotationTransform(
      [element],
      { x: 50, y: 50 },
      0,
      { x: 150, y: 50 },
      false,
      ctx,
    );

    expect(ctx.find("turned").angle).toBeCloseTo(Math.PI / 2);
  });

  it("snaps to 15° steps with shift", () => {
    const element = box("turned", { x: 0, y: 0, width: 100, height: 100 });
    const ctx = makeContext([element]);

    // 20° from the pivot rounds to 15°.
    const radians = (20 * Math.PI) / 180;
    applyRotationTransform(
      [element],
      { x: 50, y: 50 },
      0,
      { x: 50 + Math.cos(radians) * 100, y: 50 + Math.sin(radians) * 100 },
      true,
      ctx,
    );

    expect(ctx.find("turned").angle).toBeCloseTo((15 * Math.PI) / 180);
  });

  it("normalises a backwards turn into [0, 2π)", () => {
    // A negative angle in the model would compare unequal to the same visual
    // orientation reached forwards, and every angle-keyed cache would miss.
    const element = box("turned", { x: 0, y: 0, width: 100, height: 100 });
    const ctx = makeContext([element]);

    applyRotationTransform(
      [element],
      { x: 50, y: 50 },
      0,
      { x: 50, y: -100 },
      false,
      ctx,
    );

    expect(ctx.find("turned").angle).toBeCloseTo((3 * Math.PI) / 2);
  });

  it("swings a multiple selection around the shared pivot", () => {
    // Each element turns on its own centre *and* orbits the pivot, or a rotated
    // group would come apart into elements spinning in place.
    const left = box("left", { x: 0, y: 0, width: 20, height: 20 });
    const right = box("right", { x: 100, y: 0, width: 20, height: 20 });
    const ctx = makeContext([left, right]);

    applyRotationTransform(
      [left, right],
      { x: 60, y: 10 },
      0,
      { x: 60, y: 110 },
      false,
      ctx,
    );

    // A quarter turn about (60, 10) — clockwise on screen, where y grows
    // downwards — carries the left element up above the pivot.
    expect(ctx.find("left").angle).toBeCloseTo(Math.PI / 2);
    expect(ctx.find("left")).toMatchObject({ x: 50 });
    expect(ctx.find("left").y).toBeCloseTo(-50);
    expect(ctx.lastApplied.options.changedIds).toEqual(["left", "right"]);
  });

  it("leaves an element that is not in the snapshot upright", () => {
    const element = box("turned", { x: 0, y: 0, width: 100, height: 100 });
    const other = box("other", { x: 400 });
    const ctx = makeContext([element, other]);

    applyRotationTransform(
      [element],
      { x: 50, y: 50 },
      0,
      { x: 50, y: 150 },
      false,
      ctx,
    );

    expect(ctx.find("other")).toBe(other);
  });
});

describe("applyEndpointDragTransform", () => {
  const arrow = (attrs: Record<string, unknown> = {}): Shape =>
    createElement("Arrow", {
      id: "arrow",
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 0,
      ...attrs,
    })!;

  it("moves the end being dragged and leaves the other alone", () => {
    const ctx = makeContext([arrow()]);

    applyEndpointDragTransform("arrow", "end", { x: 200, y: 60 }, false, ctx);

    const dragged = ctx.find("arrow") as LinearShape;
    expect(dragged).toMatchObject({ x1: 0, y1: 0, x2: 200, y2: 60 });
    expect(ctx.lastApplied.options).toMatchObject({
      commit: false,
      changedIds: ["arrow"],
    });
  });

  it("moves the start end when that is the handle", () => {
    const ctx = makeContext([arrow()]);

    applyEndpointDragTransform("arrow", "start", { x: -50, y: -20 }, false, ctx);

    expect(ctx.find("arrow")).toMatchObject({
      x1: -50,
      y1: -20,
      x2: 100,
      y2: 0,
    });
  });

  it("binds to a shape the end is dropped on and highlights it", () => {
    // The highlight is the only cue that letting go will connect rather than
    // leave the end floating next to the shape.
    const shape = box("shape", { x: 200, y: -50, width: 100, height: 100 });
    const ctx = makeContext([arrow(), shape]);

    applyEndpointDragTransform("arrow", "end", { x: 210, y: 0 }, false, ctx);

    const dragged = ctx.find("arrow") as LinearShape;
    expect(dragged.endBinding?.elementId).toBe("shape");
    expect(ctx.visuals.bindingHighlightId).toBe("shape");
    // The head stands off the outline rather than crossing into the shape.
    expect(dragged.route[dragged.route.length - 2]).toBeLessThan(200);
  });

  it("binds the start end too, not only the end being pointed at", () => {
    // Both ends bind, and each writes its own half of the record — an arrow that
    // could only be attached tail-first is the bug this catches.
    const shape = box("shape", { x: -150, y: -50, width: 100, height: 100 });
    const ctx = makeContext([arrow(), shape]);

    applyEndpointDragTransform("arrow", "start", { x: -45, y: 0 }, false, ctx);

    const dragged = ctx.find("arrow") as LinearShape;
    expect(dragged.startBinding?.elementId).toBe("shape");
    expect(dragged.endBinding).toBeNull();
    expect(ctx.visuals.bindingHighlightId).toBe("shape");
  });

  it("releases the binding when the end is pulled away", () => {
    const shape = box("shape", { x: 200, y: -50, width: 100, height: 100 });
    const bound = arrow({
      x2: 210,
      endBinding: { elementId: "shape", focus: { x: 0, y: 0 }, gap: 10 },
    });
    const ctx = makeContext([bound, shape]);

    applyEndpointDragTransform("arrow", "end", { x: 20, y: 0 }, false, ctx);

    expect((ctx.find("arrow") as LinearShape).endBinding).toBeNull();
    expect(ctx.visuals.bindingHighlightId).toBeNull();
  });

  it("never binds a plain line, and never highlights one either", () => {
    const shape = box("shape", { x: 200, y: -50, width: 100, height: 100 });
    const line = createElement("Line", {
      id: "arrow",
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 0,
    })!;
    const ctx = makeContext([line, shape]);

    applyEndpointDragTransform("arrow", "end", { x: 210, y: 0 }, false, ctx);

    expect((ctx.find("arrow") as LinearShape).endBinding).toBeNull();
    expect(ctx.visuals.bindingHighlightId).toBeNull();
    // And the end goes exactly where the pointer is, with no standoff.
    expect((ctx.find("arrow") as LinearShape).x2).toBe(210);
  });

  it("snaps the dragged end to a nearby point, excluding the arrow itself", () => {
    /*
     * Snapping to the arrow's own geometry would let an end lock onto itself and
     * refuse to move, so the arrow is excluded from the candidates.
     */
    const ctx = makeContext([arrow()]);
    ctx.snapTo = { x: 300, y: 300 };

    applyEndpointDragTransform("arrow", "end", { x: 297, y: 302 }, false, ctx);

    expect(ctx.find("arrow")).toMatchObject({ x2: 300, y2: 300 });
    expect(ctx.snapCalls[0].options).toMatchObject({
      exclude: "arrow",
      disabled: false,
    });
  });

  it("turns point snapping off and angle snapping on with shift", () => {
    // Shift means "hold this direction", so the two snaps would fight; the angle
    // is measured from the end that is staying put.
    const ctx = makeContext([arrow()]);
    ctx.snapTo = { x: 300, y: 300 };

    applyEndpointDragTransform("arrow", "end", { x: 100, y: 8 }, true, ctx);

    expect(ctx.snapCalls[0].options).toMatchObject({ disabled: true });
    const dragged = ctx.find("arrow") as LinearShape;
    // 4.6° off horizontal rounds to flat, keeping the length the pointer implies.
    expect(dragged.y2).toBeCloseTo(0);
    expect(dragged.x2).toBeCloseTo(Math.hypot(100, 8));
  });

  it("snaps the start end's angle about the far end", () => {
    const ctx = makeContext([arrow({ x1: 100, y1: 0, x2: 0, y2: 0 })]);

    applyEndpointDragTransform("arrow", "start", { x: 100, y: 8 }, true, ctx);

    const dragged = ctx.find("arrow") as LinearShape;
    expect(dragged.y1).toBeCloseTo(0);
    expect(dragged.x1).toBeCloseTo(Math.hypot(100, 8));
  });

  it("does nothing to an id that is not in the scene", () => {
    // The arrow can be deleted by a collaborator between press and move.
    const other = box("other", { x: 400 });
    const ctx = makeContext([other]);

    applyEndpointDragTransform("gone", "end", { x: 10, y: 10 }, false, ctx);

    expect(ctx.elementsRef.current).toEqual([other]);
    expect(ctx.visuals.bindingHighlightId).toBeNull();
  });
});

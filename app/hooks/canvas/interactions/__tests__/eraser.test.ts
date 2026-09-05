/**
 * The eraser: a two-phase gesture, mark while the pointer moves and delete on
 * release.
 *
 * The marking phase must not touch the scene at all — an eraser that deleted as
 * it went could not be undone in one step, could not be taken back with `Alt`,
 * and would broadcast a burst of deletions per stroke. The failures these tests
 * guard are the ones that follow from getting that split wrong: elements the
 * stroke swept between two pointer samples never marked, `Alt` failing to give
 * one back, and a stroke that erased something still leaving it selected.
 */
import { describe, expect, it } from "vitest";
import { accumulateEraserHits, commitEraserDeletions } from "../eraser";
import { createElement } from "../../../../services/canvas/elements";
import { ERASER_RADIUS_PX } from "../types";
import { makeContext } from "./helpers/sceneContext";
import type { Shape } from "../../../../types/shapes";

const box = (id: string, x: number, y = 0): Shape =>
  createElement("Square", { id, x, y, width: 100, height: 100 })!;

describe("accumulateEraserHits", () => {
  it("marks what the stroke touches without changing the scene", () => {
    const first = box("first", 0);
    const second = box("second", 400);
    const ctx = makeContext([first, second]);
    const before = ctx.elementsRef.current;

    accumulateEraserHits({ x: 0, y: 0 }, { x: 0, y: 50 }, false, ctx);

    expect([...ctx.erasingRef.current]).toEqual(["first"]);
    expect(ctx.visuals.erasingIds).toEqual(new Set(["first"]));
    // Nothing is deleted until release, so undo gets one step and peers get one
    // message for the whole stroke.
    expect(ctx.applied).toEqual([]);
    expect(ctx.elementsRef.current).toBe(before);
  });

  it("catches an element the stroke crossed between two samples", () => {
    /*
     * Pointer events arrive as far apart as the pointer moves; a fast flick past
     * a thin shape lands both samples clear of it. Testing the segment rather
     * than the two points is what makes the eraser feel continuous.
     */
    const element = box("swept", 0);
    const ctx = makeContext([element]);

    accumulateEraserHits({ x: 50, y: -60 }, { x: 50, y: 160 }, false, ctx);

    expect([...ctx.erasingRef.current]).toEqual(["swept"]);
  });

  it("gives an element back when the stroke returns over it with alt", () => {
    const element = box("marked", 0);
    const ctx = makeContext([element]);

    accumulateEraserHits({ x: 0, y: 0 }, { x: 0, y: 50 }, false, ctx);
    expect(ctx.erasingRef.current.has("marked")).toBe(true);

    accumulateEraserHits({ x: 0, y: 50 }, { x: 0, y: 0 }, true, ctx);

    expect(ctx.erasingRef.current.size).toBe(0);
    expect(ctx.visuals.erasingIds).toEqual(new Set());
  });

  it("measures the eraser's reach in screen pixels", () => {
    // The eraser is a fixed-size brush on screen, so zoomed out it sweeps far
    // more world than zoomed in.
    const element = box("far", 0);
    const justOutside = { x: -ERASER_RADIUS_PX * 4, y: 50 };

    const atOne = makeContext([element]);
    accumulateEraserHits(justOutside, justOutside, false, atOne);
    expect(atOne.erasingRef.current.size).toBe(0);

    const zoomedOut = makeContext([element], { zoom: 0.25 });
    accumulateEraserHits(justOutside, justOutside, false, zoomedOut);
    expect(zoomedOut.erasingRef.current.size).toBe(1);
  });

  it("keeps drawing the trail even when nothing new is hit", () => {
    // The trail is the only feedback that the eraser is live over empty canvas,
    // so it is patched on every move — but the marked set is not re-sent, since
    // rebuilding it per event is what made long strokes stutter.
    const ctx = makeContext([box("first", 0)]);

    accumulateEraserHits({ x: 0, y: 0 }, { x: 0, y: 50 }, false, ctx);
    accumulateEraserHits({ x: 0, y: 50 }, { x: 5, y: 50 }, false, ctx);

    expect(ctx.patches).toHaveLength(2);
    expect(ctx.patches[0]).toHaveProperty("erasingIds");
    expect(ctx.patches[1]).not.toHaveProperty("erasingIds");
    expect(ctx.patches[1].eraserTrail).toHaveLength(2);
  });

  it("caps the trail so a long stroke does not grow without limit", () => {
    // A stroke lasting a few seconds is thousands of points; only the tail is
    // ever drawn, and keeping the rest would be re-copied on every event.
    const ctx = makeContext();

    for (let i = 0; i < 200; i += 1) {
      accumulateEraserHits({ x: i, y: 0 }, { x: i + 1, y: 0 }, false, ctx);
    }

    expect(ctx.trailRef.current).toHaveLength(64);
    // It is the tail that survives, not the head.
    expect(ctx.trailRef.current[63]).toEqual({ x: 200, y: 0 });
  });

  it("hands the visuals a copy of the trail, not the live array", () => {
    // The renderer reads the patched value; sharing the mutable ref would let
    // the next pointer event change what has already been handed over.
    const ctx = makeContext();

    accumulateEraserHits({ x: 0, y: 0 }, { x: 1, y: 1 }, false, ctx);

    expect(ctx.visuals.eraserTrail).toEqual([{ x: 1, y: 1 }]);
    expect(ctx.visuals.eraserTrail).not.toBe(ctx.trailRef.current);
  });

  it("ignores an element the stroke misses entirely", () => {
    const ctx = makeContext([box("far", 500)]);

    accumulateEraserHits({ x: 0, y: 0 }, { x: 10, y: 10 }, false, ctx);

    expect(ctx.erasingRef.current.size).toBe(0);
    expect(ctx.patches[0]).not.toHaveProperty("erasingIds");
  });

  it("does not report a change when alt passes over something unmarked", () => {
    // Holding alt from the start is a no-op stroke: `delete` on a set that never
    // held the id must not count as a change.
    const ctx = makeContext([box("first", 0)]);

    accumulateEraserHits({ x: 0, y: 0 }, { x: 0, y: 50 }, true, ctx);

    expect(ctx.patches[0]).not.toHaveProperty("erasingIds");
  });
});

describe("commitEraserDeletions", () => {
  it("deletes everything marked in one apply and clears the visuals", () => {
    const kept = box("kept", 400);
    const ctx = makeContext([box("gone", 0), kept]);
    accumulateEraserHits({ x: 0, y: 0 }, { x: 0, y: 50 }, false, ctx);

    commitEraserDeletions(ctx);

    expect(ctx.elementsRef.current).toEqual([kept]);
    expect(ctx.applied).toHaveLength(1);
    // Named deletions, and peers are sent the elements — a "none" broadcast here
    // left the shape on every other screen until the next full sync.
    expect(ctx.applied[0].options).toMatchObject({
      deletedIds: ["gone"],
      broadcast: "elements",
    });
    expect(ctx.resets).toBe(1);
    expect(ctx.erasingRef.current.size).toBe(0);
    expect(ctx.trailRef.current).toEqual([]);
  });

  it("deletes the marked set even though the visuals were reset first", () => {
    /*
     * `resetVisuals` swaps in a fresh `erasingRef`, so the delete has to hold the
     * ids it captured. Reading them back off the ref afterwards is how a stroke
     * came to reset the overlay and then delete nothing.
     */
    const ctx = makeContext([box("gone", 0)]);
    accumulateEraserHits({ x: 0, y: 0 }, { x: 0, y: 50 }, false, ctx);

    commitEraserDeletions(ctx);

    expect(ctx.elementsRef.current).toEqual([]);
  });

  it("drops an erased element from the selection", () => {
    // A selected element erased mid-stroke would otherwise leave handles floating
    // over empty canvas, and the next drag would move something that is gone.
    const ctx = makeContext([box("gone", 0), box("kept", 400)], {
      selectedIds: ["gone", "kept"],
    });
    accumulateEraserHits({ x: 0, y: 0 }, { x: 0, y: 50 }, false, ctx);

    commitEraserDeletions(ctx);

    expect(ctx.selections).toEqual([["kept"]]);
  });

  it("only resets the visuals when the stroke marked nothing", () => {
    // A click on empty canvas with the eraser: the trail has to be cleared, but
    // an apply would push an identical scene into history as an undo step.
    const ctx = makeContext([box("first", 0)]);
    accumulateEraserHits({ x: 400, y: 400 }, { x: 410, y: 400 }, false, ctx);

    commitEraserDeletions(ctx);

    expect(ctx.applied).toEqual([]);
    expect(ctx.selections).toEqual([]);
    expect(ctx.resets).toBe(1);
    expect(ctx.trailRef.current).toEqual([]);
  });
});

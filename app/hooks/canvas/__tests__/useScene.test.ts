// @vitest-environment jsdom
/**
 * The scene: the element list, the undo stack, and what peers are told.
 *
 * The bug this hook was written to fix is in its own docblock — history that
 * snapshotted the render *before* the change, so every undo replayed one action
 * too few and the first shape drawn could never be undone. The tests below pin
 * that down, and the two things that follow from it: a drag has to arrive as one
 * undo step rather than one per frame, and every change has to name what peers
 * should be sent, since a wrong `broadcast` leaves the other screens stale with
 * nothing to correct them until a full sync.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useScene, type SceneBroadcast } from "../useScene";
import { createElement } from "../../../services/canvas/elements";
import type { LinearShape, Shape } from "../../../types/shapes";

afterEach(cleanup);

const box = (id: string, attrs: Record<string, unknown> = {}): Shape =>
  createElement("Square", { id, x: 0, y: 0, width: 10, height: 10, ...attrs })!;

/** A shape and an arrow whose end is bound to it. */
const boundPair = (): { shape: Shape; arrow: LinearShape } => {
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
    endBinding: { elementId: "shape", focus: { x: 0, y: 0 }, gap: 10 },
  }) as LinearShape;

  return { shape, arrow };
};

const setup = (options: Parameters<typeof useScene>[0] = {}) =>
  renderHook((props: Parameters<typeof useScene>[0] = options) => useScene(props));

describe("applyElements", () => {
  it("writes the ref synchronously so two changes in one tick see each other", () => {
    /*
     * This is the whole reason the ref exists. Reading `elements` instead would
     * give both updaters the same starting array, and the second would silently
     * drop the first one's element.
     */
    const { result } = setup();

    act(() => {
      result.current.applyElements((previous) => [...previous, box("first")]);
      result.current.applyElements((previous) => [...previous, box("second")]);
    });

    expect(result.current.elements.map((element) => element.id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("returns the array it wrote", () => {
    const { result } = setup();
    let returned: Shape[] = [];

    act(() => {
      returned = result.current.applyElements([box("first")]);
    });

    expect(returned).toBe(result.current.elementsRef.current);
  });

  it("accepts a plain array as well as an updater", () => {
    const { result } = setup({ initialElements: [box("old")] });

    act(() => {
      result.current.applyElements([box("new")]);
    });

    expect(result.current.elements.map((element) => element.id)).toEqual(["new"]);
  });

  it("does nothing at all when the updater returns the same array", () => {
    // A no-op gesture — a click that selected nothing, a drag of zero distance —
    // must not push an undo step or wake the other screens up.
    const onChange = vi.fn();
    const initial = [box("first")];
    const { result } = setup({ initialElements: initial, onChange });

    act(() => {
      result.current.applyElements((previous) => previous);
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(result.current.canUndo).toBe(false);
    expect(result.current.elementsRef.current).toBe(initial);
  });
});

describe("history", () => {
  it("can undo the very first shape drawn", () => {
    // The bug this hook replaced: history captured the render before the change,
    // so the first shape had no earlier state to go back to.
    const { result } = setup();

    act(() => {
      result.current.applyElements([box("first")]);
    });
    expect(result.current.canUndo).toBe(true);

    act(() => result.current.undo());

    expect(result.current.elements).toEqual([]);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
  });

  it("redoes what it undid", () => {
    const { result } = setup();

    act(() => {
      result.current.applyElements([box("first")]);
    });
    act(() => result.current.undo());
    act(() => result.current.redo());

    expect(result.current.elements.map((element) => element.id)).toEqual(["first"]);
    expect(result.current.canRedo).toBe(false);
  });

  it("leaves a mid-gesture change out of the stack", () => {
    /*
     * Every pointer move during a drag applies with `commit: false`. One step per
     * frame would make undo useless — a hundred presses to take back one drag.
     */
    const { result } = setup();

    act(() => {
      result.current.applyElements([box("dragged")], { commit: false });
      result.current.applyElements([box("dragged", { x: 50 })], { commit: false });
      result.current.applyElements([box("dragged", { x: 90 })]);
    });

    expect(result.current.elements[0].x).toBe(90);
    act(() => result.current.undo());
    // One undo, and the whole drag is gone.
    expect(result.current.elements).toEqual([]);
  });

  it("ignores a commit that changes nothing", () => {
    // Called on release whether or not anything moved, so an unchanged scene must
    // not need two undo presses to get past.
    const { result } = setup();

    act(() => {
      result.current.applyElements([box("first")]);
    });
    act(() => result.current.commit());
    act(() => result.current.undo());

    expect(result.current.elements).toEqual([]);
  });

  it("sees a change of the same length as a real step", () => {
    // A restyle or a move keeps the element count; the version is what says the
    // scene moved on.
    const first = box("first");
    const { result } = setup({ initialElements: [first] });

    act(() => {
      result.current.applyElements([box("first", { stroke: "#e03131", version: 2 })]);
    });
    act(() => result.current.undo());

    expect(result.current.elements).toEqual([first]);
  });

  it("commits an explicit snapshot when given one", () => {
    const { result } = setup();

    act(() => {
      result.current.applyElements([box("first")], { commit: false });
      result.current.commit(result.current.elementsRef.current);
    });
    act(() => result.current.undo());

    expect(result.current.elements).toEqual([]);
  });

  it("throws away the redo branch once a new change lands", () => {
    // Undoing and then drawing something else is a new branch; keeping the old
    // one reachable would let redo produce a scene the user never had.
    const { result } = setup();

    act(() => {
      result.current.applyElements([box("first")]);
    });
    act(() => result.current.undo());
    act(() => {
      result.current.applyElements([box("second")]);
    });

    expect(result.current.canRedo).toBe(false);
    expect(result.current.elements.map((element) => element.id)).toEqual(["second"]);
  });

  it("does nothing when there is nothing to undo or redo", () => {
    const { result } = setup();

    act(() => result.current.undo());
    act(() => result.current.redo());

    expect(result.current.elements).toEqual([]);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it("keeps the last hundred steps and forgets the oldest", () => {
    // The stack is capped so a long session cannot grow without limit; what it
    // drops is the far end, not the recent history.
    const { result } = setup();

    act(() => {
      for (let i = 1; i <= 120; i += 1) {
        result.current.applyElements((previous) => [...previous, box(`shape-${i}`)]);
      }
    });

    act(() => {
      for (let i = 0; i < 200 && result.current.canUndo; i += 1) {
        result.current.undo();
      }
    });

    expect(result.current.canUndo).toBe(false);
    // 100 snapshots survive, the oldest of which holds 21 elements.
    expect(result.current.elements).toHaveLength(21);
  });

  it("resets the stack to a loaded scene without telling anyone", () => {
    /*
     * Used when a board is loaded from storage or a peer's full sync arrives.
     * Broadcasting it would echo the scene straight back to the room, and leaving
     * the old history in place would let undo walk into a scene from another
     * board entirely.
     */
    const onChange = vi.fn();
    const { result } = setup({ onChange });

    act(() => {
      result.current.applyElements([box("local")]);
    });
    onChange.mockClear();

    act(() => result.current.resetHistory([box("loaded")]));

    expect(result.current.elements.map((element) => element.id)).toEqual(["loaded"]);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("broadcast", () => {
  const lastPayload = (onChange: ReturnType<typeof vi.fn>): SceneBroadcast =>
    onChange.mock.calls[onChange.mock.calls.length - 1][0];

  it("sends only the elements the caller named", () => {
    // The common case. Sending the whole scene on every change is what made a
    // busy room crawl.
    const onChange = vi.fn();
    const { result } = setup({
      initialElements: [box("first"), box("second")],
      onChange,
    });

    act(() => {
      result.current.applyElements(
        (previous) => [...previous, box("third")],
        { changedIds: ["third"] },
      );
    });

    const payload = lastPayload(onChange);
    expect(payload.mode).toBe("elements");
    expect(payload.changed.map((element) => element.id)).toEqual(["third"]);
    expect(payload.elements).toHaveLength(3);
  });

  it("works out what changed when the caller does not say", () => {
    // Version-indexed rather than a nested scan, so a thousand-element scene does
    // not cost a million comparisons.
    const onChange = vi.fn();
    const { result } = setup({
      initialElements: [box("first"), box("second")],
      onChange,
    });

    act(() => {
      result.current.applyElements((previous) => [
        previous[0],
        box("second", { x: 90, version: 2 }),
      ]);
    });

    expect(lastPayload(onChange).changed.map((element) => element.id)).toEqual([
      "second",
    ]);
  });

  it("sends the whole scene when the change is structural", () => {
    // Reordering, undo and clear cannot be expressed as a list of changed
    // elements: the peer has to be told the new order outright.
    const onChange = vi.fn();
    const { result } = setup({ initialElements: [box("first")], onChange });

    act(() => {
      result.current.applyElements([box("first"), box("second")], {
        broadcast: "full",
      });
    });

    const payload = lastPayload(onChange);
    expect(payload.mode).toBe("full");
    expect(payload.changed).toBe(payload.elements);
  });

  it("stays quiet when the change is local", () => {
    const onChange = vi.fn();
    const { result } = setup({ onChange });

    act(() => {
      result.current.applyElements([box("first")], { broadcast: "none" });
    });

    expect(onChange).not.toHaveBeenCalled();
    // The scene still changed locally, and still went on the undo stack.
    expect(result.current.elements).toHaveLength(1);
    expect(result.current.canUndo).toBe(true);
  });

  it("passes the deleted ids through", () => {
    const onChange = vi.fn();
    const { result } = setup({
      initialElements: [box("first"), box("second")],
      onChange,
    });

    act(() => {
      result.current.applyElements(
        (previous) => previous.filter((element) => element.id !== "first"),
        { deletedIds: ["first"] },
      );
    });

    expect(lastPayload(onChange).deletedIds).toEqual(["first"]);
  });

  it("works out the deleted ids when the caller does not name them", () => {
    // Otherwise a deletion that came from anywhere but the eraser would leave the
    // shape on every other screen.
    const onChange = vi.fn();
    const { result } = setup({
      initialElements: [box("first"), box("second")],
      onChange,
    });

    act(() => {
      result.current.applyElements((previous) => previous.slice(1));
    });

    expect(lastPayload(onChange).deletedIds).toEqual(["first"]);
  });

  it("reports no deletions when nothing was removed", () => {
    const onChange = vi.fn();
    const { result } = setup({ initialElements: [box("first")], onChange });

    act(() => {
      result.current.applyElements((previous) => [...previous, box("second")]);
    });

    expect(lastPayload(onChange).deletedIds).toEqual([]);
  });

  it("tells peers the whole scene on undo and redo", () => {
    // A peer cannot reconstruct an undo from a list of changed elements — the
    // step may have removed several and reordered the rest.
    const onChange = vi.fn();
    const { result } = setup({ onChange });

    act(() => {
      result.current.applyElements([box("first")]);
    });
    onChange.mockClear();

    act(() => result.current.undo());
    expect(lastPayload(onChange)).toMatchObject({ mode: "full", deletedIds: [] });
    expect(lastPayload(onChange).elements).toEqual([]);

    act(() => result.current.redo());
    expect(lastPayload(onChange).elements).toHaveLength(1);
  });

  it("uses the callback from the latest render, not the first", () => {
    /*
     * `applyElements` is memoised and handed to child components, so it outlives
     * any one render. Closing over `onChange` directly would keep sending to the
     * socket the component had when it mounted.
     */
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(
      ({ onChange }: { onChange: (payload: SceneBroadcast) => void }) =>
        useScene({ onChange }),
      { initialProps: { onChange: first as (payload: SceneBroadcast) => void } },
    );

    rerender({ onChange: second as (payload: SceneBroadcast) => void });

    act(() => {
      result.current.applyElements([box("first")]);
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("binding reconciliation", () => {
  it("drops an arrow's binding when its shape is deleted", () => {
    // Left in place, the arrow would keep hugging an outline that is no longer
    // there, and would snap back to it the next time anything re-solved it.
    const { shape, arrow } = boundPair();
    const { result } = setup({ initialElements: [shape, arrow] });

    act(() => {
      result.current.applyElements(
        (previous) => previous.filter((element) => element.id !== "shape"),
        { deletedIds: ["shape"] },
      );
    });

    const remaining = result.current.elements[0] as LinearShape;
    expect(remaining.endBinding).toBeNull();
  });

  it("leaves the bindings alone when the caller opts out", () => {
    // Paste and remote merges reconcile once at the end instead of on every
    // intermediate array, where a half-built scene would lose live bindings.
    const { shape, arrow } = boundPair();
    const { result } = setup({ initialElements: [shape, arrow] });

    act(() => {
      result.current.applyElements(
        (previous) => previous.filter((element) => element.id !== "shape"),
        { deletedIds: ["shape"], reconcileBindings: false },
      );
    });

    const remaining = result.current.elements[0] as LinearShape;
    expect(remaining.endBinding?.elementId).toBe("shape");
  });

  it("only reconciles when the element count changed", () => {
    // A move or a restyle cannot orphan a binding, so the scan is skipped — it is
    // the one pass over the whole scene that every gesture would otherwise pay.
    const { shape, arrow } = boundPair();
    const { result } = setup({ initialElements: [shape, arrow] });

    act(() => {
      result.current.applyElements((previous) =>
        previous.map((element) =>
          element.id === "shape" ? box("shape", { version: 2 }) : element,
        ),
      );
    });

    const remaining = result.current.elements[1] as LinearShape;
    expect(remaining.endBinding?.elementId).toBe("shape");
  });
});

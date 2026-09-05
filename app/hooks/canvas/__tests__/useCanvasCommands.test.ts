// @vitest-environment jsdom
/**
 * The menu and shortcut commands: delete, duplicate, nudge, clipboard, z-order,
 * clear and export.
 *
 * Each one is a whole user action rather than a step of a gesture, so each has
 * to arrive as exactly one undo step and name what peers are sent. The failures
 * these tests hold down are the ones that survive a casual try of the editor:
 * a container deleted while its label stays behind, a duplicate that keeps the
 * original's bindings so an arrow follows the copy, a paste that lands exactly
 * on top of what it copied, and a reorder broadcast as changed elements — which
 * a peer cannot apply, because order is not a property of any one element.
 */
import { useRef } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCanvasCommands } from "../useCanvasCommands";
import { createElement } from "../../../services/canvas/elements";
import { exportSceneToDataURL } from "../../../services/canvas/renderer";
import type { LinearShape, Shape, ToolType } from "../../../types/shapes";

vi.mock("../../../services/canvas/renderer", () => ({
  exportSceneToDataURL: vi.fn(() => "data:image/png;base64,PIXELS"),
}));

interface AppliedCall {
  options: {
    changedIds?: string[];
    deletedIds?: string[];
    broadcast?: "full" | "elements";
  };
  result: Shape[];
}

const box = (id: string, attrs: Record<string, unknown> = {}): Shape =>
  createElement("Square", { id, x: 0, y: 0, width: 100, height: 100, ...attrs })!;

/** A container carrying its label's back-reference, as bound text is stored. */
const labelled = (): Shape[] => [
  box("container", { boundElements: [{ id: "label", type: "text" }] }),
  createElement("Text", { id: "label", x: 10, y: 10, text: "hello" })!,
];

/** A shape and the arrow whose end is bound to it. */
const boundPair = (): Shape[] => [
  box("shape", { boundElements: [{ id: "arrow", type: "arrow" }] }),
  createElement("Arrow", {
    id: "arrow",
    x1: 300,
    y1: 50,
    x2: 110,
    y2: 50,
    endBinding: { elementId: "shape", focus: { x: 0, y: 0 }, gap: 10 },
  })!,
];

/**
 * Mirrors how Canvas wires the hook: a live `elementsRef` plus an `applyElements`
 * that writes the updater's result back synchronously, so a command that calls
 * it twice sees its own first write — and that records the options, since those
 * decide the undo granularity and what goes down the socket.
 */
const mount = (elements: readonly Shape[] = [], selectedIds: string[] = [], zoom = 1) => {
  const applied: AppliedCall[] = [];
  const selections: string[][] = [];
  const tools: ToolType[] = [];
  const elementsRef = { current: [...elements] as Shape[] };

  const { result, rerender } = renderHook(
    ({ ids }: { ids: string[] }) => {
      const ref = useRef(elementsRef).current;
      const viewportRef = useRef({ zoom });
      return useCanvasCommands({
        elementsRef: ref,
        selectedIds: ids,
        setSelectedIds: (next) => selections.push(next),
        setTool: (tool) => tools.push(tool),
        applyElements: (updater, options = {}) => {
          const next =
            typeof updater === "function" ? updater(ref.current) : updater;
          ref.current = next;
          applied.push({ options, result: next });
          return next;
        },
        viewportRef,
      });
    },
    { initialProps: { ids: selectedIds } },
  );

  return {
    applied,
    selections,
    tools,
    elementsRef,
    get commands() {
      return result.current;
    },
    /** The ids in the scene, in draw order — z-order is the array order. */
    order: () => elementsRef.current.map((element) => element.id),
    find: (id: string): Shape => {
      const element = elementsRef.current.find((item) => item.id === id);
      if (!element) throw new Error(`no element ${id} in the scene`);
      return element;
    },
    select: (ids: string[]) => rerender({ ids }),
    get lastApplied() {
      return applied[applied.length - 1];
    },
  };
};

/** Anchor clicks, the one seam the export walks through. */
let clicked: HTMLAnchorElement[];

beforeEach(() => {
  clicked = [];
  vi.mocked(exportSceneToDataURL).mockReturnValue("data:image/png;base64,PIXELS");
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    function mockClick(this: HTMLAnchorElement) {
      clicked.push(this);
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("deleteSelection", () => {
  it("removes the selection, names it, and drops the handles", () => {
    const scene = mount([box("gone"), box("kept", { x: 400 })], ["gone"]);

    act(() => scene.commands.deleteSelection());

    expect(scene.order()).toEqual(["kept"]);
    expect(scene.lastApplied.options.deletedIds).toEqual(["gone"]);
    expect(scene.selections).toEqual([[]]);
  });

  it("takes a container's label with it", () => {
    /*
     * Bound text is not selectable on its own, so a label left behind after its
     * container is deleted can never be reached again — it just sits there, and
     * is still exported and still counted by every "is the board empty" check.
     */
    const scene = mount(labelled(), ["container"]);

    act(() => scene.commands.deleteSelection());

    expect(scene.order()).toEqual([]);
    expect(scene.lastApplied.options.deletedIds).toEqual(["container", "label"]);
  });

  it("leaves a bound arrow in place", () => {
    // An arrow between two shapes outlives either of them: it keeps its other
    // end and simply loses the binding. Sweeping it up with the shape would
    // silently delete a connector the user never selected.
    const scene = mount(boundPair(), ["shape"]);

    act(() => scene.commands.deleteSelection());

    expect(scene.order()).toEqual(["arrow"]);
  });

  it("does nothing with an empty selection", () => {
    const scene = mount([box("first")], []);

    act(() => scene.commands.deleteSelection());

    expect(scene.applied).toEqual([]);
    expect(scene.selections).toEqual([]);
  });
});

describe("duplicateSelection", () => {
  it("adds an offset copy and moves the selection onto it", () => {
    // The copy has to be offset, or it lands exactly on the original and the
    // user cannot tell the command worked.
    const scene = mount([box("original")], ["original"]);

    act(() => scene.commands.duplicateSelection());

    expect(scene.elementsRef.current).toHaveLength(2);
    const copy = scene.elementsRef.current[1];
    expect(copy.id).not.toBe("original");
    expect(copy).toMatchObject({ x: 10, y: 10 });
    expect(scene.selections).toEqual([[copy.id]]);
    expect(scene.lastApplied.options.changedIds).toEqual([copy.id]);
  });

  it("copies without the original's bindings or back-references", () => {
    /*
     * A copy that kept `boundElements` would make the original's arrow follow
     * the copy around, and a copied arrow that kept its binding would snap back
     * onto a shape it is no longer attached to.
     */
    const scene = mount(boundPair(), ["shape", "arrow"]);

    act(() => scene.commands.duplicateSelection());

    const copies = scene.elementsRef.current.slice(2);
    expect(copies).toHaveLength(2);
    expect(copies[0].boundElements).toBeNull();
    expect((copies[1] as LinearShape).endBinding).toBeNull();
  });

  it("does nothing when the selected ids are no longer in the scene", () => {
    // A collaborator deleted them between the selection and the shortcut.
    const scene = mount([box("first")], ["gone"]);

    act(() => scene.commands.duplicateSelection());

    expect(scene.applied).toEqual([]);
    expect(scene.selections).toEqual([]);
  });

  it("does nothing with an empty selection", () => {
    const scene = mount([box("first")], []);

    act(() => scene.commands.duplicateSelection());

    expect(scene.applied).toEqual([]);
  });
});

describe("nudgeSelection", () => {
  it("moves only the selection, by exactly the arrow key's step", () => {
    const scene = mount([box("moved"), box("still", { x: 400 })], ["moved"]);

    act(() => scene.commands.nudgeSelection(0, -1));

    expect(scene.find("moved")).toMatchObject({ x: 0, y: -1 });
    expect(scene.find("still")).toMatchObject({ x: 400, y: 0 });
    expect(scene.lastApplied.options.changedIds).toEqual(["moved"]);
  });

  it("drags a bound arrow along with the shape", () => {
    // The keyboard path has to settle bindings for itself; nothing else in a
    // nudge re-solves them, so the arrow would stay behind while its shape left.
    const scene = mount(boundPair(), ["shape"]);

    act(() => scene.commands.nudgeSelection(0, 200));

    const arrow = scene.find("arrow") as LinearShape;
    expect(arrow.route[arrow.route.length - 1]).toBeGreaterThan(150);
    // The far end stayed where the user put it.
    expect(arrow.y1).toBe(50);
  });

  it("keeps a binding that is still within reach", () => {
    // Nudging an arrow a few units must not detach it, or a keyboard alignment
    // pass would quietly break every connector it touched.
    const scene = mount(boundPair(), ["arrow"]);

    act(() => scene.commands.nudgeSelection(5, 0));

    expect((scene.find("arrow") as LinearShape).endBinding?.elementId).toBe("shape");
  });

  it("measures that reach in world units scaled by the zoom", () => {
    /*
     * The binding gap is a screen distance, so zoomed in the same nudge takes the
     * end much further from the outline in the units the geometry works in. At
     * this zoom the 15-unit gap is outside the reach the previous test was inside.
     */
    const scene = mount(boundPair(), ["arrow"], 2);

    act(() => scene.commands.nudgeSelection(5, 0));

    expect((scene.find("arrow") as LinearShape).endBinding).toBeNull();
  });

  it("does nothing with an empty selection", () => {
    const scene = mount([box("first")], []);

    act(() => scene.commands.nudgeSelection(1, 0));

    expect(scene.applied).toEqual([]);
  });
});

describe("selectAll", () => {
  it("selects every element and returns to the selection tool", () => {
    // Select-all with a drawing tool still active would leave the very next drag
    // drawing a new shape over the selection instead of moving it.
    const scene = mount([box("first"), box("second", { x: 400 })], []);

    act(() => scene.commands.selectAll());

    expect(scene.selections).toEqual([["first", "second"]]);
    expect(scene.tools).toEqual(["Select"]);
  });

  it("selects nothing on an empty board without touching the scene", () => {
    const scene = mount([], []);

    act(() => scene.commands.selectAll());

    expect(scene.selections).toEqual([[]]);
    expect(scene.applied).toEqual([]);
  });
});

describe("the clipboard", () => {
  it("copies without changing the scene or telling peers", () => {
    // Copy is the one command that is invisible to everyone else.
    const scene = mount([box("first")], ["first"]);

    act(() => scene.commands.copySelection());

    expect(scene.applied).toEqual([]);
    expect(scene.commands.clipboardRef.current.map((element) => element.id)).toEqual([
      "first",
    ]);
  });

  it("holds a snapshot, so editing the original does not change what pastes", () => {
    /*
     * The clipboard survives any number of later edits. Storing the live element
     * would make copy-move-paste produce two shapes in the same place instead of
     * one where it was and one where it is.
     */
    const scene = mount([box("first")], ["first"]);

    act(() => scene.commands.copySelection());
    act(() => scene.commands.nudgeSelection(100, 100));
    act(() => scene.commands.paste());

    const pasted = scene.elementsRef.current[1];
    expect(pasted).toMatchObject({ x: 20, y: 20 });
  });

  it("pastes an offset copy, selects it and returns to the selection tool", () => {
    const scene = mount([box("first")], ["first"]);

    act(() => scene.commands.copySelection());
    act(() => scene.commands.paste());

    const pasted = scene.elementsRef.current[1];
    expect(pasted.id).not.toBe("first");
    expect(pasted).toMatchObject({ x: 20, y: 20 });
    expect(scene.lastApplied.options.changedIds).toEqual([pasted.id]);
    expect(scene.selections[scene.selections.length - 1]).toEqual([pasted.id]);
    expect(scene.tools).toEqual(["Select"]);
  });

  it("pastes again from the same copy, with fresh ids each time", () => {
    // Paste does not consume the clipboard, and two pastes must not share ids —
    // duplicate ids in one scene make every id lookup ambiguous.
    const scene = mount([box("first")], ["first"]);

    act(() => scene.commands.copySelection());
    act(() => scene.commands.paste());
    act(() => scene.commands.paste());

    const [, firstPaste, secondPaste] = scene.elementsRef.current;
    expect(secondPaste.id).not.toBe(firstPaste.id);
  });

  it("does nothing when nothing has been copied", () => {
    const scene = mount([box("first")], ["first"]);

    act(() => scene.commands.paste());

    expect(scene.applied).toEqual([]);
    expect(scene.selections).toEqual([]);
  });

  it("copies nothing when the selection is empty, and pastes nothing after", () => {
    const scene = mount([box("first")], []);

    act(() => scene.commands.copySelection());
    act(() => scene.commands.paste());

    expect(scene.commands.clipboardRef.current).toEqual([]);
    expect(scene.applied).toEqual([]);
  });

  it("cuts by copying first, so the clipboard outlives the deletion", () => {
    // The order matters: deleting first would leave the clipboard reading a scene
    // the element is already gone from, and cut-paste would lose the shape.
    const scene = mount([box("first")], ["first"]);

    act(() => scene.commands.cutSelection());

    expect(scene.order()).toEqual([]);
    expect(scene.commands.clipboardRef.current.map((element) => element.id)).toEqual([
      "first",
    ]);

    act(() => scene.commands.paste());
    expect(scene.elementsRef.current).toHaveLength(1);
  });
});

describe("reorderSelection", () => {
  const four = () => [
    box("a"),
    box("b", { x: 100 }),
    box("c", { x: 200 }),
    box("d", { x: 300 }),
  ];

  it("brings the selection to the front", () => {
    // Draw order is array order, so the front is the end of the list.
    const scene = mount(four(), ["a"]);

    act(() => scene.commands.reorderSelection("front"));

    expect(scene.order()).toEqual(["b", "c", "d", "a"]);
  });

  it("sends the selection to the back", () => {
    const scene = mount(four(), ["d"]);

    act(() => scene.commands.reorderSelection("back"));

    expect(scene.order()).toEqual(["d", "a", "b", "c"]);
  });

  it("steps one place forward, not all the way", () => {
    const scene = mount(four(), ["b"]);

    act(() => scene.commands.reorderSelection("forward"));

    expect(scene.order()).toEqual(["a", "c", "b", "d"]);
  });

  it("steps one place backward", () => {
    const scene = mount(four(), ["c"]);

    act(() => scene.commands.reorderSelection("backward"));

    expect(scene.order()).toEqual(["a", "c", "b", "d"]);
  });

  it("keeps an adjacent selection in its own order as it moves", () => {
    /*
     * Two neighbours both moving forward must step over the element above them,
     * not swap with each other — swapping would leave the pair in place while
     * appearing to shuffle, which is what makes a repeated shortcut look broken.
     */
    const scene = mount(four(), ["b", "c"]);

    act(() => scene.commands.reorderSelection("forward"));

    expect(scene.order()).toEqual(["a", "d", "b", "c"]);
  });

  it("leaves the frontmost element alone when asked to go forward", () => {
    const scene = mount(four(), ["d"]);

    act(() => scene.commands.reorderSelection("forward"));

    expect(scene.order()).toEqual(["a", "b", "c", "d"]);
  });

  it("leaves the backmost element alone when asked to go backward", () => {
    const scene = mount(four(), ["a"]);

    act(() => scene.commands.reorderSelection("backward"));

    expect(scene.order()).toEqual(["a", "b", "c", "d"]);
  });

  it("tells peers the whole scene, because order is not a property", () => {
    // A changed-elements message carries no order, so the peer would keep drawing
    // the old stack and the two screens would disagree about what is on top.
    const scene = mount(four(), ["a"]);

    act(() => scene.commands.reorderSelection("front"));

    expect(scene.lastApplied.options.broadcast).toBe("full");
  });

  it("does nothing with an empty selection", () => {
    const scene = mount(four(), []);

    act(() => scene.commands.reorderSelection("front"));

    expect(scene.applied).toEqual([]);
  });
});

describe("clearCanvas", () => {
  it("empties the board, tells peers outright, and drops the selection", () => {
    const scene = mount([box("first"), box("second", { x: 400 })], ["first"]);

    act(() => scene.commands.clearCanvas());

    expect(scene.order()).toEqual([]);
    expect(scene.lastApplied.options.broadcast).toBe("full");
    expect(scene.selections).toEqual([[]]);
  });

  it("does nothing on a board that is already empty", () => {
    // Otherwise clear pushes an identical scene onto the stack, and the undo that
    // follows appears to do nothing at all.
    const scene = mount([], []);

    act(() => scene.commands.clearCanvas());

    expect(scene.applied).toEqual([]);
    expect(scene.selections).toEqual([]);
  });
});

describe("exportPNG", () => {
  it("downloads the rendered scene under a dated name", () => {
    const scene = mount([box("first")], []);

    act(() => scene.commands.exportPNG());

    expect(clicked).toHaveLength(1);
    expect(clicked[0].href).toBe("data:image/png;base64,PIXELS");
    expect(clicked[0].download).toMatch(/^collabdraw-\d{4}-\d{2}-\d{2}\.png$/);
  });

  it("exports what is in the scene now, not what was rendered", () => {
    // The ref, not a captured array: the toolbar button holds the same callback
    // for the life of the session.
    const scene = mount([box("first")], ["first"]);

    act(() => scene.commands.duplicateSelection());
    act(() => scene.commands.exportPNG());

    expect(vi.mocked(exportSceneToDataURL).mock.calls[0][0]).toHaveLength(2);
  });

  it("does nothing when there is nothing to draw", () => {
    // An empty board has no bounding box to size the image from, so the renderer
    // declines; clicking a link with an empty href would navigate the page away.
    vi.mocked(exportSceneToDataURL).mockReturnValue(null);
    const scene = mount([], []);

    act(() => scene.commands.exportPNG());

    expect(clicked).toEqual([]);
  });
});

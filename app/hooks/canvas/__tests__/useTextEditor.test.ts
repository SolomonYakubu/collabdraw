// @vitest-environment jsdom
/**
 * Text editing: opening the overlay, keeping the element in step with the
 * textarea, and deciding on close whether anything is worth keeping.
 *
 * Almost every failure here is a stray element or a lost undo step. Text created
 * by a click and then abandoned must leave nothing behind — not an empty element,
 * not an undo step, and not a dangling `boundElements` entry on the shape it was
 * going to label. Text that *was* typed has to arrive as exactly one undo step
 * however many keystrokes it took, which is why the live updates apply with
 * `commit: false` and the close commits once.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { getTextEditorGeometry, useTextEditor } from "../useTextEditor";
import { createElement, mutateElement } from "../../../services/canvas/elements";
import { measureTextElement } from "../../../services/canvas/textMeasure";
import { DEFAULT_STYLE } from "../../../types/shapes";
import type { ElementStyle, Shape, TextShape } from "../../../types/shapes";
import type { ApplyOptions, ElementsUpdater } from "../useScene";

afterEach(cleanup);

const text = (id: string, attrs: Record<string, unknown> = {}): TextShape =>
  createElement(
    "Text",
    { id, x: 0, y: 0, text: "hello", ...attrs },
    DEFAULT_STYLE.stroke,
    DEFAULT_STYLE,
  ) as TextShape;

const container = (id: string, attrs: Record<string, unknown> = {}): Shape =>
  createElement("Square", { id, x: 0, y: 0, width: 200, height: 100, ...attrs })!;

/** The scene refs and the apply recorder the hook is handed at run time. */
const makeHarness = (initial: readonly Shape[] = [], style: ElementStyle = DEFAULT_STYLE) => {
  const harness = {
    elementsRef: { current: [...initial] as Shape[] },
    applied: [] as Array<{ options: ApplyOptions; result: Shape[] }>,
    selections: [] as string[][],
    style,

    applyElements(updater: ElementsUpdater, options: ApplyOptions = {}): Shape[] {
      const next =
        typeof updater === "function"
          ? updater(harness.elementsRef.current)
          : updater;
      harness.elementsRef.current = next;
      harness.applied.push({ options, result: next });
      return next;
    },

    setSelectedIds(ids: string[]): void {
      harness.selections.push(ids);
    },

    find(id: string): Shape {
      const element = harness.elementsRef.current.find((item) => item.id === id);
      if (!element) {
        throw new Error(`no element ${id} in the scene`);
      }
      return element;
    },

    has(id: string): boolean {
      return harness.elementsRef.current.some((item) => item.id === id);
    },

    get lastApplied() {
      return harness.applied[harness.applied.length - 1];
    },
  };

  return harness;
};

type Harness = ReturnType<typeof makeHarness>;

const setup = (harness: Harness) =>
  renderHook(() =>
    useTextEditor({
      elementsRef: harness.elementsRef,
      applyElements: harness.applyElements,
      style: harness.style,
      setSelectedIds: harness.setSelectedIds,
    }),
  );

describe("startEditing", () => {
  it("opens an existing text element and selects it", () => {
    const harness = makeHarness([text("label")]);
    const { result } = setup(harness);

    act(() => result.current.startEditing("label"));

    expect(result.current.editingId).toBe("label");
    expect(result.current.editingElement?.text).toBe("hello");
    // The selection follows the editor, so the style panel shows the right values.
    expect(harness.selections).toEqual([["label"]]);
  });

  it("does nothing for an element a collaborator has already erased", () => {
    const harness = makeHarness();
    const { result } = setup(harness);

    act(() => result.current.startEditing("gone"));

    expect(result.current.editingId).toBeNull();
    expect(harness.selections).toEqual([]);
  });

  it("refuses to open something that is not text", () => {
    // A double-click on a shape routes through `createAndEdit`; opening the shape
    // itself as a text element would type into an object with no `text` field.
    const harness = makeHarness([container("square")]);
    const { result } = setup(harness);

    act(() => result.current.startEditing("square"));

    expect(result.current.editingId).toBeNull();
  });
});

describe("createAndEdit", () => {
  it("adds a text element centred on the click, uncommitted", () => {
    /*
     * The click point is where the caret should sit, so the element is lifted by
     * half a line — otherwise typing appears to start below the cursor. Nothing is
     * committed yet: an abandoned click must not leave an undo step.
     */
    const harness = makeHarness();
    const { result } = setup(harness);

    act(() => result.current.createAndEdit({ x: 40, y: 100 }));

    const created = harness.elementsRef.current[0] as TextShape;
    expect(created.tool).toBe("Text");
    expect(created).toMatchObject({
      x: 40,
      y: 100 - DEFAULT_STYLE.fontSize / 2,
      text: "",
      containerId: null,
    });
    expect(harness.lastApplied.options).toMatchObject({
      commit: false,
      changedIds: [created.id],
    });
    expect(result.current.editingId).toBe(created.id);
    expect(harness.selections).toEqual([[created.id]]);
  });

  it("takes the current style, not the style it mounted with", () => {
    // The style panel can be changed between mounting the canvas and typing.
    const harness = makeHarness();
    const { result, rerender } = renderHook(
      ({ style }: { style: ElementStyle }) =>
        useTextEditor({
          elementsRef: harness.elementsRef,
          applyElements: harness.applyElements,
          style,
          setSelectedIds: harness.setSelectedIds,
        }),
      { initialProps: { style: DEFAULT_STYLE } },
    );

    rerender({ style: { ...DEFAULT_STYLE, fontSize: 36, stroke: "#e03131" } });
    act(() => result.current.createAndEdit({ x: 0, y: 100 }));

    const created = harness.elementsRef.current[0] as TextShape;
    expect(created.fontSize).toBe(36);
    expect(created.stroke).toBe("#e03131");
    expect(created.y).toBe(100 - 18);
  });

  it("labels a container and writes the back-reference into it", () => {
    /*
     * The container carries a `boundElements` entry pointing at its label; that
     * back-reference is what makes the label move, resize and delete with the
     * shape. Committing the label alone leaves text that a drag walks away from.
     */
    const harness = makeHarness([container("square")]);
    const { result } = setup(harness);

    act(() => result.current.createAndEdit({ x: 100, y: 50 }, "square"));

    const label = harness.find(result.current.editingId!) as TextShape;
    expect(label.containerId).toBe("square");
    expect(harness.find("square").boundElements).toEqual([
      { id: label.id, type: "text" },
    ]);
  });

  it("keeps the container's other bound elements", () => {
    // An arrow already attached to the shape must not be dropped by the label.
    const harness = makeHarness([
      container("square", { boundElements: [{ id: "arrow", type: "arrow" }] }),
    ]);
    const { result } = setup(harness);

    act(() => result.current.createAndEdit({ x: 100, y: 50 }, "square"));

    expect(harness.find("square").boundElements).toEqual([
      { id: "arrow", type: "arrow" },
      { id: result.current.editingId, type: "text" },
    ]);
  });

  it("edits the label a container already has instead of adding a second", () => {
    // Double-clicking a labelled shape reopens its text; two labels on one
    // container would draw on top of each other and only one would ever reflow.
    const existing = text("label", { containerId: "square" });
    const harness = makeHarness([
      container("square", { boundElements: [{ id: "label", type: "text" }] }),
      existing,
    ]);
    const { result } = setup(harness);

    act(() => result.current.createAndEdit({ x: 100, y: 50 }, "square"));

    expect(result.current.editingId).toBe("label");
    expect(harness.applied).toEqual([]);
    expect(harness.elementsRef.current).toHaveLength(2);
  });

  it("treats a container id that is no longer in the scene as free text", () => {
    const harness = makeHarness();
    const { result } = setup(harness);

    act(() => result.current.createAndEdit({ x: 0, y: 0 }, "gone"));

    expect((harness.elementsRef.current[0] as TextShape).containerId).toBeNull();
  });
});

describe("updateText", () => {
  it("does nothing when no editor is open", () => {
    const harness = makeHarness([text("label")]);
    const { result } = setup(harness);

    act(() => result.current.updateText("typed"));

    expect(harness.applied).toEqual([]);
  });

  it("grows free text to fit what has been typed, without committing", () => {
    /*
     * Free text has no container to bound it, so the element *is* its content —
     * left unmeasured, the selection outline and the eraser would both work from
     * the size the first keystroke had.
     */
    const harness = makeHarness([text("label", { text: "" })]);
    const { result } = setup(harness);
    act(() => result.current.startEditing("label"));

    act(() => result.current.updateText("a much longer line of text"));

    const updated = harness.find("label") as TextShape;
    const measured = measureTextElement(updated);
    expect(updated.text).toBe("a much longer line of text");
    expect(updated.width).toBeCloseTo(measured.width);
    expect(updated.height).toBeCloseTo(measured.height);
    expect(harness.lastApplied.options).toMatchObject({
      commit: false,
      changedIds: ["label"],
    });
  });

  it("measures each line, so a newline makes the element taller", () => {
    const harness = makeHarness([text("label", { text: "one" })]);
    const { result } = setup(harness);
    act(() => result.current.startEditing("label"));

    act(() => result.current.updateText("one"));
    const single = (harness.find("label") as TextShape).height;
    act(() => result.current.updateText("one\ntwo\nthree"));

    expect((harness.find("label") as TextShape).height).toBeCloseTo(single * 3);
  });

  it("reflows the container instead of resizing a bound label", () => {
    // A label is laid out inside its container, so the container is what grows;
    // resizing the label itself would push the text outside the shape.
    const harness = makeHarness([
      container("square", {
        height: 40,
        boundElements: [{ id: "label", type: "text" }],
      }),
      text("label", { text: "", containerId: "square" }),
    ]);
    const { result } = setup(harness);
    act(() => result.current.startEditing("label"));

    act(() => result.current.updateText("one\ntwo\nthree\nfour\nfive"));

    expect(harness.find("square").height).toBeGreaterThan(40);
    expect((harness.find("label") as TextShape).text).toBe(
      "one\ntwo\nthree\nfour\nfive",
    );
  });

  it("leaves the scene untouched when the element has been erased mid-edit", () => {
    // Returning the same array is what `useScene` reads as "nothing happened", so
    // no undo step is pushed and no peer is told.
    const harness = makeHarness([text("label")]);
    const { result } = setup(harness);
    act(() => result.current.startEditing("label"));

    const before = harness.elementsRef.current;
    harness.elementsRef.current = [];
    act(() => result.current.updateText("typed"));

    expect(harness.lastApplied.result).toBe(harness.elementsRef.current);
    expect(harness.elementsRef.current).not.toBe(before);
    expect(harness.elementsRef.current).toEqual([]);
  });

  it("leaves the scene untouched when the id now belongs to a shape", () => {
    const harness = makeHarness([text("label")]);
    const { result } = setup(harness);
    act(() => result.current.startEditing("label"));

    const replaced = [container("label")];
    harness.elementsRef.current = replaced;
    act(() => result.current.updateText("typed"));

    expect(harness.elementsRef.current).toBe(replaced);
  });
});

describe("stopEditing", () => {
  it("does nothing when no editor is open", () => {
    const harness = makeHarness();
    const { result } = setup(harness);

    act(() => result.current.stopEditing());

    expect(harness.applied).toEqual([]);
  });

  it("commits typed text as a single undo step", () => {
    /*
     * Every keystroke applied with `commit: false`, so without this one commit the
     * whole sentence would be missing from history — and the *previous* undo step
     * would take back the text along with whatever came before it.
     */
    const harness = makeHarness([text("label", { text: "" })]);
    const { result } = setup(harness);
    act(() => result.current.startEditing("label"));
    act(() => result.current.updateText("typed"));

    act(() => result.current.stopEditing());

    expect(result.current.editingId).toBeNull();
    expect(harness.lastApplied.options).toMatchObject({ changedIds: ["label"] });
    // The default is a commit; the live updates were the ones opting out.
    expect(harness.lastApplied.options.commit).toBeUndefined();
    expect((harness.find("label") as TextShape).text).toBe("typed");
  });

  it("commits nothing when the text was opened and left as it was", () => {
    // Clicking into text and out again is not an edit; an undo step here would
    // swallow the user's next undo press.
    const harness = makeHarness([text("label", { text: "hello" })]);
    const { result } = setup(harness);
    act(() => result.current.startEditing("label"));
    act(() => result.current.updateText("hello"));
    harness.applied.length = 0;

    act(() => result.current.stopEditing());

    expect(harness.applied).toEqual([]);
    expect(result.current.editingId).toBeNull();
  });

  it("removes text that was created and never typed into, with no undo step", () => {
    /*
     * A click with the text tool that the user thinks better of. Left behind, the
     * element is invisible but still exported, still counted by "is the board
     * empty", and still catches the eraser.
     */
    const harness = makeHarness();
    const { result } = setup(harness);
    act(() => result.current.createAndEdit({ x: 0, y: 0 }));
    const id = result.current.editingId!;
    harness.applied.length = 0;

    act(() => result.current.stopEditing());

    expect(harness.elementsRef.current).toEqual([]);
    expect(harness.lastApplied.options).toMatchObject({
      commit: false,
      deletedIds: [id],
    });
    expect(harness.selections[harness.selections.length - 1]).toEqual([]);
  });

  it("commits the deletion when existing text is emptied out", () => {
    // Here the element did exist, so its removal is a real change the user must
    // be able to undo.
    const harness = makeHarness([text("label", { text: "hello" })]);
    const { result } = setup(harness);
    act(() => result.current.startEditing("label"));
    act(() => result.current.updateText(""));

    act(() => result.current.stopEditing());

    expect(harness.has("label")).toBe(false);
    expect(harness.lastApplied.options).toMatchObject({
      commit: true,
      deletedIds: ["label"],
    });
  });

  it("treats whitespace as empty", () => {
    const harness = makeHarness([text("label", { text: "hello" })]);
    const { result } = setup(harness);
    act(() => result.current.startEditing("label"));
    act(() => result.current.updateText("   \n  "));

    act(() => result.current.stopEditing());

    expect(harness.has("label")).toBe(false);
  });

  it("clears the container's back-reference when its label is dropped", () => {
    // A `boundElements` entry pointing at a deleted label makes the container
    // reflow around text that is not there, and re-label attempts reopen nothing.
    const harness = makeHarness([
      container("square", { boundElements: [{ id: "label", type: "text" }] }),
      text("label", { text: "hello", containerId: "square" }),
    ]);
    const { result } = setup(harness);
    act(() => result.current.startEditing("label"));
    act(() => result.current.updateText(""));

    act(() => result.current.stopEditing());

    expect(harness.find("square").boundElements).toBeNull();
  });

  it("keeps the container's other bindings when its label is dropped", () => {
    const harness = makeHarness([
      container("square", {
        boundElements: [
          { id: "arrow", type: "arrow" },
          { id: "label", type: "text" },
        ],
      }),
      text("label", { text: "hello", containerId: "square" }),
    ]);
    const { result } = setup(harness);
    act(() => result.current.startEditing("label"));
    act(() => result.current.updateText(""));

    act(() => result.current.stopEditing());

    expect(harness.find("square").boundElements).toEqual([
      { id: "arrow", type: "arrow" },
    ]);
  });

  it("leaves the rest of the scene by identity when a label is dropped", () => {
    // The delete walks every element to find the back-reference; rebuilding the
    // ones it does not change would make every other element look changed to the
    // peers, and re-send the whole scene as a "deletion".
    const bystander = container("bystander", { x: 400 });
    const linked = container("linked", {
      x: 800,
      boundElements: [{ id: "arrow", type: "arrow" }],
    });
    const harness = makeHarness([
      container("square", { boundElements: [{ id: "label", type: "text" }] }),
      text("label", { text: "hello", containerId: "square" }),
      bystander,
      linked,
    ]);
    const { result } = setup(harness);
    act(() => result.current.startEditing("label"));
    act(() => result.current.updateText(""));

    act(() => result.current.stopEditing());

    expect(harness.find("bystander")).toBe(bystander);
    expect(harness.find("linked")).toBe(linked);
  });

  it("closes cleanly when the element has gone by the time it is asked to", () => {
    // The element can be erased by a collaborator while the textarea is open.
    const harness = makeHarness([text("label")]);
    const { result } = setup(harness);
    act(() => result.current.startEditing("label"));
    harness.elementsRef.current = [];
    harness.applied.length = 0;

    act(() => result.current.stopEditing());

    expect(result.current.editingId).toBeNull();
    expect(harness.applied).toEqual([]);
  });
});

describe("editingElement", () => {
  it("goes null when the element being edited is erased under it", () => {
    // The overlay reads this to decide whether to draw; a stale element would
    // leave a textarea floating over a shape that no longer exists.
    const harness = makeHarness([text("label")]);
    const { result, rerender } = setup(harness);
    act(() => result.current.startEditing("label"));
    expect(result.current.editingElement).not.toBeNull();

    harness.elementsRef.current = [];
    rerender();

    expect(result.current.editingElement).toBeNull();
    expect(result.current.editingId).toBe("label");
  });
});

describe("getTextEditorGeometry", () => {
  it("reports the element's bounds for positioning the textarea", () => {
    const element = mutateElement(text("label"), { x: 12, y: 30 }) as TextShape;

    expect(getTextEditorGeometry(element).bounds).toMatchObject({
      x: 12,
      y: 30,
      width: element.width,
      height: element.height,
    });
  });
});

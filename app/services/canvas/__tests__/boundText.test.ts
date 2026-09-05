/**
 * Labels bound to a container shape.
 *
 * The failure this file exists to prevent is a label that does not match the
 * shape it lives in: text clipped by an ellipse that only inscribes part of its
 * box, a label left hanging where the container used to be after the container
 * grew, or a container that shrinks under the caret while someone is still
 * typing into it.
 *
 * Text is measured through `textMeasure`, which here goes to node-canvas's real
 * 2D context (`app/testSetup.ts`). Glyph widths are therefore font metrics and
 * not arithmetic, so the assertions below are written against line counts, line
 * height (`fontSize * 1.25`) and `measureTextWidth` itself rather than against
 * hard-coded pixel widths.
 */
import { describe, expect, it } from "vitest";
import { createElement, mutateElement } from "../elements";
import { measureTextWidth } from "../textMeasure";
import {
  BOUND_TEXT_PADDING,
  fitLabelToContainer,
  getBoundLabel,
  getContainerTextBox,
  getInnerRatio,
  getLabelContainer,
  getRequiredContainerSize,
  layoutBoundText,
  measureBoundText,
  reflowContainerWithLabel,
} from "../boundText";
import type { ElementType, Shape, TextShape } from "../../../types/shapes";

const container = (
  tool: ElementType,
  box: { x?: number; y?: number; width: number; height: number },
  id = "container-1",
): Shape => createElement(tool, { id, ...box })!;

/** A label already attached to `containerId`, both directions of the link. */
const labelled = (
  text: string,
  containerShape: Shape,
  attrs: { fontSize?: number; id?: string } = {},
): { container: Shape; label: TextShape } => {
  const label = createElement("Text", {
    id: attrs.id ?? "label-1",
    text,
    fontSize: attrs.fontSize ?? 20,
    containerId: containerShape.id,
  }) as TextShape;

  return {
    container: mutateElement(containerShape, {
      boundElements: [{ id: label.id, type: "text" }],
    }),
    label,
  };
};

describe("getInnerRatio", () => {
  it("gives each shape only the room it actually encloses", () => {
    // A circle's inscribed square is the box divided by root two; a diamond and
    // a triangle enclose half. Treating these as 1 is what let labels spill out
    // over the outline.
    expect(getInnerRatio({ tool: "Square" } as Shape)).toBe(1);
    expect(getInnerRatio({ tool: "Text" } as Shape)).toBe(1);
    expect(getInnerRatio({ tool: "Circle" } as Shape)).toBeCloseTo(0.7071);
    expect(getInnerRatio({ tool: "Diamond" } as Shape)).toBe(0.5);
    expect(getInnerRatio({ tool: "Triangle" } as Shape)).toBe(0.5);
  });
});

describe("getContainerTextBox", () => {
  it("insets a rectangle by the padding on both sides", () => {
    expect(getContainerTextBox(container("Square", { width: 200, height: 100 })))
      .toEqual({
        x: BOUND_TEXT_PADDING,
        y: BOUND_TEXT_PADDING,
        width: 200 - BOUND_TEXT_PADDING * 2,
        height: 100 - BOUND_TEXT_PADDING * 2,
      });
  });

  it("centres the smaller box a circle leaves", () => {
    const box = getContainerTextBox(
      container("Circle", { x: 40, y: 60, width: 200, height: 200 }),
    );

    expect(box.width).toBeCloseTo(200 / Math.SQRT2 - 10);
    expect(box.height).toBeCloseTo(box.width);
    // Equal gaps left and right: the inscribed square is concentric with the
    // ellipse, not pinned to its top-left corner.
    expect(box.x - 40).toBeCloseTo(240 - (box.x + box.width));
    expect(box.y - 60).toBeCloseTo(260 - (box.y + box.height));
  });

  it("pushes a triangle's label down to where the shape is wide", () => {
    // There is no room at the apex. Without the bias, a one-line label sits on
    // the centre line and its first and last characters fall outside the edges.
    const box = getContainerTextBox(
      container("Triangle", { width: 200, height: 100 }),
    );

    expect(box).toEqual({ x: 55, y: 55, width: 90, height: 40 });
    expect(box.y).toBeGreaterThan(50);
    expect(box.y + box.height).toBeLessThanOrEqual(100);
  });

  it("never returns a negative box for a container smaller than its padding", () => {
    // Dragging a shape out to a couple of pixels used to produce a negative
    // width, which `wrapText` then treated as "no wrapping at all".
    const box = getContainerTextBox(container("Square", { width: 4, height: 2 }));
    expect(box.width).toBe(BOUND_TEXT_PADDING * 2);
    expect(box.height).toBe(BOUND_TEXT_PADDING * 2);
  });
});

describe("getRequiredContainerSize", () => {
  it("inverts getContainerTextBox, so the content fits exactly", () => {
    const content = { width: 120, height: 50 };
    const size = getRequiredContainerSize("Diamond", content);
    const box = getContainerTextBox(
      container("Diamond", { width: size.width, height: size.height }),
    );

    expect(box.width).toBeCloseTo(content.width);
    expect(box.height).toBeCloseTo(content.height);
  });

  it("adds the caller's padding to the width twice and the height once", () => {
    const size = getRequiredContainerSize("Square", { width: 100, height: 40 }, 8);
    expect(size.width).toBe(100 + 10 + 16);
    expect(size.height).toBe(40 + 10 + 8);
  });
});

describe("measureBoundText", () => {
  it("reports the wrapped height, not the height of one line", () => {
    // 60px holds "aaaaa" but not "aaaaa bbbbb", so the label is two lines tall
    // even though the text has no newline in it.
    const measured = measureBoundText("aaaaa bbbbb", 60, 20, "sans-serif");
    expect(measured.lines).toEqual(["aaaaa", "bbbbb"]);
    expect(measured.height).toBeCloseTo(2 * 25);
    // The width is the widest line, not the width of the whole string.
    expect(measured.width).toBeCloseTo(
      measureTextWidth("bbbbb", 20, "sans-serif"),
    );
    expect(measured.width).toBeLessThan(
      measureTextWidth("aaaaa bbbbb", 20, "sans-serif"),
    );
  });

  it("keeps one line of height for empty text so the caret has somewhere to sit", () => {
    expect(measureBoundText("", 100, 20, "sans-serif").height).toBeCloseTo(25);
  });
});

describe("layoutBoundText", () => {
  it("centres the label vertically in the space it has", () => {
    const shape = container("Square", { x: 0, y: 0, width: 200, height: 100 });
    const { label } = labelled("hi", shape);
    const next = layoutBoundText(label, shape);

    // Box is 5..95 tall; one 25px line leaves 65px to split above and below.
    expect(next).toMatchObject({
      x: 5,
      y: 5 + 32.5,
      width: 190,
      height: 25,
      textAlign: "center",
      verticalAlign: "middle",
    });
  });

  it("aligns to the top rather than off the top when the text overflows", () => {
    // Six 25px lines in a 40px-tall box: the offset must clamp at 0, or the
    // label would be positioned above the container it belongs to.
    const shape = container("Square", { width: 60, height: 50 });
    const { label } = labelled("aaaaa bbbbb ccccc ddddd eeeee fffff", shape);
    const next = layoutBoundText(label, shape);

    expect(next.height).toBeGreaterThan(40);
    expect(next.y).toBe(5);
  });
});

describe("fitLabelToContainer", () => {
  it("leaves a label that already fits alone", () => {
    const shape = container("Square", { width: 300, height: 200 });
    const { label } = labelled("Bob", shape);
    const result = fitLabelToContainer(label, shape);

    expect(result.container).toBe(shape);
    expect(result.label.fontSize).toBe(20);
  });

  it("shrinks the font before it touches a deliberately sized shape", () => {
    /*
     * The inscribed square of a 46px circle is only ~22px across, narrower than
     * "Bob" at font size 20 — which rendered as "Bo" over a cut-off "b". The
     * shape keeps its size; the text gives.
     */
    const shape = container("Circle", { width: 46, height: 46 });
    const { label } = labelled("Bob", shape);
    const result = fitLabelToContainer(label, shape);

    expect(result.label.fontSize).toBeLessThan(20);
    expect(result.container).toBe(shape);
    const box = getContainerTextBox(result.container);
    const measured = measureBoundText(
      "Bob",
      box.width,
      result.label.fontSize,
      result.label.fontFamily,
    );
    expect(measured.width).toBeLessThanOrEqual(box.width);
    expect(measured.height).toBeLessThanOrEqual(box.height);
  });

  it("stops shrinking at the minimum readable size and grows the container", () => {
    /*
     * A paragraph in a small box cannot be made to fit by shrinking — below
     * 10px it would be unreadable, so the container has to give. It grows
     * downwards only: the width the author chose is preserved.
     */
    const shape = container("Square", { x: 20, y: 30, width: 80, height: 40 });
    const { label } = labelled(
      "one two three four five six seven eight nine ten eleven twelve",
      shape,
    );
    const result = fitLabelToContainer(label, shape);

    expect(result.label.fontSize).toBe(10);
    expect(result.container.height).toBeGreaterThan(40);
    expect(result.container.width).toBe(80);
    expect(result.container.x).toBe(20);
    expect(result.container.y).toBe(30);

    // And the label is laid out inside the container it just grew, not the old
    // one — the bug this returns both halves to avoid.
    const grown = getContainerTextBox(result.container);
    expect(result.label.y).toBeGreaterThanOrEqual(grown.y);
    expect(result.label.height).toBeLessThanOrEqual(grown.height);
  });

  it("grows a diamond by more than its label, because it only encloses half", () => {
    const shape = container("Diamond", { width: 80, height: 30 });
    const { label } = labelled("one two three four five six seven", shape);
    const result = fitLabelToContainer(label, shape);

    const box = getContainerTextBox(result.container);
    const measured = measureBoundText(
      result.label.text,
      box.width,
      result.label.fontSize,
      result.label.fontFamily,
    );
    expect(box.height + 0.001).toBeGreaterThanOrEqual(measured.height);
  });
});

describe("getLabelContainer", () => {
  const shape = container("Square", { width: 100, height: 100 });
  const { label } = labelled("hi", shape);

  it("finds the container a label points at", () => {
    expect(getLabelContainer(label, [shape, label])).toBe(shape);
  });

  it("returns null for free-standing text", () => {
    const free = createElement("Text", { text: "hi" }) as TextShape;
    expect(getLabelContainer(free, [shape, free])).toBeNull();
  });

  it("returns null when the container has been deleted from under it", () => {
    // A label can outlive its container by one frame during an undo, and every
    // caller has to cope with that rather than dereference undefined.
    expect(getLabelContainer(label, [label])).toBeNull();
  });
});

describe("getBoundLabel", () => {
  it("finds the text bound to a container, ignoring bound arrows", () => {
    const shape = container("Square", { width: 100, height: 100 });
    const { container: withLabel, label } = labelled("hi", shape);
    const withArrowToo = mutateElement(withLabel, {
      boundElements: [
        { id: "arrow-9", type: "arrow" },
        { id: label.id, type: "text" },
      ],
    });

    expect(getBoundLabel(withArrowToo, [withArrowToo, label])).toBe(label);
  });

  it("returns null when nothing is bound", () => {
    const shape = container("Square", { width: 100, height: 100 });
    expect(getBoundLabel(shape, [shape])).toBeNull();
  });

  it("returns null when the bound id is missing or is not text", () => {
    // A stale `boundElements` entry survives a delete in older saved scenes, so
    // the id may point at nothing — or, after an id collision, at a shape.
    const shape = container("Square", { width: 100, height: 100 });
    const stale = mutateElement(shape, {
      boundElements: [{ id: "gone", type: "text" }],
    });
    expect(getBoundLabel(stale, [stale])).toBeNull();

    const notText = createElement("Circle", { id: "gone", width: 5, height: 5 })!;
    expect(getBoundLabel(stale, [stale, notText])).toBeNull();
  });
});

describe("reflowContainerWithLabel", () => {
  it("grows the container and re-centres the label, leaving the rest alone", () => {
    const other = createElement("Square", { id: "other", width: 10, height: 10 })!;
    const { container: shape, label } = labelled(
      "one two three four five six seven eight",
      container("Square", { x: 0, y: 0, width: 80, height: 30 }),
    );
    const scene = [other, shape, label];

    const next = reflowContainerWithLabel(scene, shape.id);
    const nextContainer = next.find((element) => element.id === shape.id)!;
    const nextLabel = next.find((element) => element.id === label.id) as TextShape;

    expect(next).toHaveLength(3);
    expect(next[0]).toBe(other);
    expect(nextContainer.height).toBeGreaterThan(30);
    expect(nextContainer.width).toBe(80);

    // The label must be centred in the grown container, not the original one.
    const box = getContainerTextBox(nextContainer);
    const measured = measureBoundText(
      nextLabel.text,
      box.width,
      nextLabel.fontSize,
      nextLabel.fontFamily,
    );
    expect(measured.height).toBeLessThanOrEqual(box.height);
    expect(nextLabel.y).toBeCloseTo(box.y + (box.height - measured.height) / 2);
    expect(nextLabel.width).toBeCloseTo(box.width);
  });

  it("never shrinks a container, because that feels jumpy under the caret", () => {
    // Deleting a word must not snap the box back: the height only ratchets up.
    const { container: shape, label } = labelled(
      "hi",
      container("Square", { width: 400, height: 300 }),
    );
    const next = reflowContainerWithLabel([shape, label], shape.id);
    const nextContainer = next.find((element) => element.id === shape.id)!;

    expect(nextContainer.height).toBe(300);
    expect(nextContainer).toBe(shape);
  });

  it("returns a copy when the container or the label is gone", () => {
    /*
     * Called from the text editor on every keystroke, so it runs at least once
     * against a scene the caller has already changed. It must return a new array
     * either way — a caller that gets its own array back would set state to the
     * same reference and skip the re-render.
     */
    const { container: shape, label } = labelled(
      "hi",
      container("Square", { width: 100, height: 100 }),
    );

    const orphaned = [label];
    const withoutContainer = reflowContainerWithLabel(orphaned, shape.id);
    expect(withoutContainer).toEqual([label]);
    expect(withoutContainer).not.toBe(orphaned);

    const unlabelled = container("Square", { width: 100, height: 100 }, "bare");
    const scene = [unlabelled];
    const withoutLabel = reflowContainerWithLabel(scene, "bare");
    expect(withoutLabel).toEqual([unlabelled]);
    expect(withoutLabel).not.toBe(scene);
  });
});

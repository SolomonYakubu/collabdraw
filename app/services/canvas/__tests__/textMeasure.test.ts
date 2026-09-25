import { describe, expect, it } from "vitest";

import { createElement, mutateElement } from "../elements";
import { getTextLines } from "../textMeasure";
import type { TextShape } from "../../../types/shapes";

const label = (attrs: Record<string, unknown> = {}): TextShape =>
  createElement("Text", {
    id: "t",
    text: "one two three",
    width: 40,
    height: 20,
    containerId: "c1",
    ...attrs,
  }) as TextShape;

describe("getTextLines", () => {
  it("wraps a bound label to its container width", () => {
    const lines = getTextLines(label());

    // "one two three" does not fit on one 40px line; wrapping breaks it up.
    expect(lines.length).toBeGreaterThan(1);
  });

  it("returns the cached lines for the same element", () => {
    const element = label();

    expect(getTextLines(element)).toBe(getTextLines(element));
  });

  it("re-wraps once the element is replaced by an edit", () => {
    // Every edit goes through `mutateElement`, which returns a new object; the
    // cache must key on that identity, or an edited label would draw stale text.
    const element = label();
    const before = getTextLines(element);

    const edited = mutateElement(element, { text: "a different label" });

    expect(getTextLines(edited)).not.toBe(before);
    // The edit's own text is what gets laid out, not the cached old lines.
    expect(getTextLines(edited).join("").replace(/\s+/g, "")).toBe(
      "adifferentlabel",
    );
  });

  it("does not wrap free text that is not bound to a container", () => {
    expect(getTextLines(label({ containerId: null }))).toEqual([
      "one two three",
    ]);
  });
});

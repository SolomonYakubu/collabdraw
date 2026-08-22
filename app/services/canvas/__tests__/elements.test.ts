import { describe, expect, it } from "vitest";
import { ELEMENT_TYPES } from "../../../types/shapes";
import { hitTestElement } from "../hitTest";
import {
  createElement,
  duplicateElement,
  getElementBounds,
  mutateElement,
  resizeElementToBox,
  restoreElement,
  restoreElements,
  translateElement,
} from "../elements";
import type { FreehandShape, LinearShape, SquareShape } from "../../../types/shapes";

const square = () =>
  createElement("Square", { x: 10, y: 20, width: 100, height: 50 }) as SquareShape;

const arrow = () =>
  createElement("Arrow", { x1: 0, y1: 0, x2: 100, y2: 50 }) as LinearShape;

describe("createElement", () => {
  it("fills in every required field", () => {
    const element = square();
    expect(element.seed).toBeGreaterThan(0);
    expect(element.version).toBe(1);
    expect(element.angle).toBe(0);
    expect(element.opacity).toBe(100);
    expect(element.strokeStyle).toBe("solid");
  });

  it("keeps a provided seed, so a shape renders identically for every peer", () => {
    const element = createElement("Square", { seed: 4242, width: 5, height: 5 })!;
    expect(element.seed).toBe(4242);
  });

  it("derives a linear element's bounding box from its endpoints", () => {
    const element = createElement("Line", { x1: 80, y1: 90, x2: 20, y2: 10 })!;
    expect(getElementBounds(element)).toEqual({
      x: 20,
      y: 10,
      width: 60,
      height: 80,
    });
  });

  it("normalises a rectangle dragged up and to the left", () => {
    const element = createElement("Square", {
      x: 100,
      y: 100,
      width: -40,
      height: -20,
    })!;
    expect(element).toMatchObject({ x: 60, y: 80, width: 40, height: 20 });
  });

  it("gives arrows an arrowhead and plain lines none", () => {
    expect((createElement("Arrow", {}) as LinearShape).endArrowhead).toBe(true);
    expect((createElement("Line", {}) as LinearShape).endArrowhead).toBe(false);
  });

  it("rejects unknown tools", () => {
    // @ts-expect-error deliberately invalid
    expect(createElement("Nonsense", {})).toBeNull();
  });
});

describe("every element type is fully wired", () => {
  /*
   * Adding a shape used to mean remembering a hand-written list in the pointer
   * machine, the restore aliases, the renderer and the hit test. The triangle got
   * added to the model and to the toolbar but not to the drawable list, so its
   * tool selected and then drew nothing. These walk the model instead.
   */
  const drawable = ELEMENT_TYPES.filter((type) => type !== "Text");

  it("can be constructed", () => {
    for (const type of ELEMENT_TYPES) {
      expect(createElement(type, { width: 40, height: 40 }), type).not.toBeNull();
    }
  });

  it("survives a round trip through restore, by its own name", () => {
    for (const type of ELEMENT_TYPES) {
      const created = createElement(type, {
        width: 40,
        height: 40,
        x1: 0,
        y1: 0,
        x2: 40,
        y2: 40,
        points: [0, 0, 10, 10],
        text: "hi",
      })!;

      expect(restoreElement(created)?.tool, type).toBe(type);
    }
  });

  it("reports non-zero bounds once it has been given a size", () => {
    for (const type of drawable) {
      const created = createElement(type, {
        width: 40,
        height: 40,
        x1: 0,
        y1: 0,
        x2: 40,
        y2: 40,
        points: [0, 0, 40, 40],
      })!;

      const bounds = getElementBounds(created);
      expect(bounds.width, type).toBeGreaterThan(0);
      expect(bounds.height, type).toBeGreaterThan(0);
    }
  });

  it("is hittable on its own outline", () => {
    for (const type of drawable) {
      const created = createElement(type, {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        x1: 0,
        y1: 0,
        x2: 100,
        y2: 100,
        points: [0, 0, 100, 100],
      })!;

      // Every drawable shape passes through or near its own top-left-to-centre
      // diagonal region; test a point on its resolved outline instead.
      const bounds = getElementBounds(created);
      const onOutline =
        type === "Line" || type === "Arrow" || type === "Freehand"
          ? { x: 50, y: 50 }
          : { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height };

      expect(hitTestElement(onOutline, created, 8), type).toBe(true);
    }
  });
});

describe("mutateElement", () => {
  it("bumps the version so the render cache invalidates", () => {
    const element = square();
    expect(mutateElement(element, { x: 0 }).version).toBe(element.version + 1);
  });

  it("does not mutate the original", () => {
    const element = square();
    mutateElement(element, { x: 999 });
    expect(element.x).toBe(10);
  });
});

describe("translateElement", () => {
  it("moves a box", () => {
    expect(translateElement(square(), 5, -5)).toMatchObject({ x: 15, y: 15 });
  });

  it("moves both endpoints of a linear element", () => {
    const moved = translateElement(arrow(), 10, 10) as LinearShape;
    expect([moved.x1, moved.y1, moved.x2, moved.y2]).toEqual([10, 10, 110, 60]);
  });

  it("moves every freehand point", () => {
    const stroke = createElement("Freehand", {
      points: [0, 0, 10, 10],
    }) as FreehandShape;
    const moved = translateElement(stroke, 3, 4) as FreehandShape;
    expect(moved.points).toEqual([3, 4, 13, 14]);
    expect(getElementBounds(moved)).toEqual({ x: 3, y: 4, width: 10, height: 10 });
  });

  it("returns the same object for a zero delta", () => {
    const element = square();
    expect(translateElement(element, 0, 0)).toBe(element);
  });
});

describe("resizeElementToBox", () => {
  it("scales freehand points into the new box", () => {
    const stroke = createElement("Freehand", {
      points: [0, 0, 10, 0, 10, 10],
    }) as FreehandShape;

    const resized = resizeElementToBox(stroke, {
      x: 0,
      y: 0,
      width: 20,
      height: 20,
    }) as FreehandShape;

    expect(resized.points).toEqual([0, 0, 20, 0, 20, 20]);
  });

  it("scales a linear element's endpoints", () => {
    const resized = resizeElementToBox(arrow(), {
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    }) as LinearShape;

    expect([resized.x1, resized.y1, resized.x2, resized.y2]).toEqual([
      0, 0, 200, 100,
    ]);
  });

  it("never collapses to zero", () => {
    const resized = resizeElementToBox(square(), {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
    expect(resized.width).toBeGreaterThan(0);
    expect(resized.height).toBeGreaterThan(0);
  });
});

describe("duplicateElement", () => {
  it("gets a new identity and drops bindings", () => {
    const original = { ...arrow(), startBinding: { elementId: "x", focus: { x: 0, y: 0 }, gap: 4 } };
    const copy = duplicateElement(original, 10) as LinearShape;

    expect(copy.id).not.toBe(original.id);
    expect(copy.seed).not.toBe(original.seed);
    expect(copy.startBinding).toBeNull();
    expect(copy.x1).toBe(original.x1 + 10);
  });
});

describe("restoreElement", () => {
  it("accepts legacy tool spellings", () => {
    expect(restoreElement({ tool: "Rect", width: 10, height: 10 })?.tool).toBe(
      "Square",
    );
    expect(restoreElement({ tool: "Ellipse", width: 10, height: 10 })?.tool).toBe(
      "Circle",
    );
  });

  it("rejects junk instead of throwing", () => {
    expect(restoreElement(null)).toBeNull();
    expect(restoreElement({})).toBeNull();
    expect(restoreElement({ tool: "Sandwich" })).toBeNull();
    expect(restoreElements("not an array")).toEqual([]);
  });

  it("survives missing geometry from a partial payload", () => {
    const element = restoreElement({ tool: "Square" });
    expect(element).toMatchObject({ x: 0, y: 0, width: 0, height: 0 });
  });
});

import { describe, expect, it } from "vitest";
import { createElement, getElementBounds, translateElement } from "../elements";
import {
  applyBindings,
  createBinding,
  getHoveredBindableElement,
  MIN_BINDING_GAP,
  releaseBindingsOutsideElements,
  removeStaleBindings,
  settleBindingsAfterMove,
  updateBoundElements,
} from "../bindings";
import { hitTestElement } from "../hitTest";
import { getBoundPoint } from "../linearElement";
import type { LinearShape, Shape } from "../../../types/shapes";

const makeScene = () => {
  const boxA = createElement("Square", {
    id: "a",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  })!;
  const boxB = createElement("Square", {
    id: "b",
    x: 300,
    y: 0,
    width: 100,
    height: 100,
  })!;
  const connector = createElement("Arrow", {
    id: "arrow",
    x1: 100,
    y1: 50,
    x2: 300,
    y2: 50,
  })!;

  return [boxA, boxB, connector];
};

const bindBoth = (): Shape[] => {
  const elements = makeScene();
  return applyBindings(elements, "arrow", {
    start: createBinding(elements[0], { x: 100, y: 50 }, 24),
    end: createBinding(elements[1], { x: 300, y: 50 }, 24),
  });
};

const arrowOf = (elements: readonly Shape[]): LinearShape =>
  elements.find((element) => element.id === "arrow") as LinearShape;

describe("getHoveredBindableElement", () => {
  it("finds a shape the pointer is near", () => {
    const [boxA] = makeScene();
    expect(getHoveredBindableElement({ x: 105, y: 50 }, [boxA], 24)?.id).toBe("a");
  });

  it("ignores shapes that are too far away", () => {
    const [boxA] = makeScene();
    expect(getHoveredBindableElement({ x: 400, y: 50 }, [boxA], 24)).toBeNull();
  });

  it("never binds an arrow to itself", () => {
    const elements = makeScene();
    expect(
      getHoveredBindableElement({ x: 200, y: 50 }, elements, 24, "arrow")?.id,
    ).not.toBe("arrow");
  });
});

describe("applyBindings", () => {
  it("records the binding and the reverse reference", () => {
    const elements = bindBoth();
    const arrow = arrowOf(elements);

    expect(arrow.startBinding?.elementId).toBe("a");
    expect(arrow.endBinding?.elementId).toBe("b");
    expect(
      elements.find((element) => element.id === "a")?.boundElements,
    ).toEqual([{ id: "arrow", type: "arrow" }]);
  });

  it("clears the reverse reference when a binding is removed", () => {
    const unbound = applyBindings(bindBoth(), "arrow", { start: null });
    expect(
      unbound.find((element) => element.id === "a")?.boundElements,
    ).toBeNull();
    expect(arrowOf(unbound).startBinding).toBeNull();
  });

  it("keeps the arrow endpoints outside the shapes it connects", () => {
    const elements = bindBoth();
    const arrow = arrowOf(elements);
    const boxA = elements.find((element) => element.id === "a")!;
    const boxB = elements.find((element) => element.id === "b")!;

    expect(hitTestElement({ x: arrow.x1, y: arrow.y1 }, boxA, 0)).toBe(false);
    expect(hitTestElement({ x: arrow.x2, y: arrow.y2 }, boxB, 0)).toBe(false);
    expect(arrow.x1).toBeGreaterThanOrEqual(100 + MIN_BINDING_GAP - 0.001);
    expect(arrow.x2).toBeLessThanOrEqual(300 - MIN_BINDING_GAP + 0.001);
  });
});

describe("updateBoundElements", () => {
  it("moves a bound endpoint when its shape moves", () => {
    const elements = bindBoth();
    const before = arrowOf(elements);

    const moved = elements.map((element) =>
      element.id === "b" ? translateElement(element, 200, 0) : element,
    );
    const updated = updateBoundElements(moved, new Set(["b"]));
    const after = arrowOf(updated);

    // The end followed box B; the start stayed put on box A.
    expect(after.x2).toBeGreaterThan(before.x2);
    expect(after.x1).toBeCloseTo(before.x1);
  });

  it("follows a shape moved vertically, sliding around its outline", () => {
    const elements = bindBoth();
    const moved = elements.map((element) =>
      element.id === "b" ? translateElement(element, 0, 300) : element,
    );
    const after = arrowOf(updateBoundElements(moved, new Set(["b"])));

    expect(after.y2).toBeGreaterThan(200);
    const boxB = moved.find((element) => element.id === "b")!;
    expect(hitTestElement({ x: after.x2, y: after.y2 }, boxB, 0)).toBe(false);
  });

  it("keeps the endpoint on the shape after it is resized", () => {
    const elements = bindBoth();
    const resized = elements.map((element) =>
      element.id === "b"
        ? { ...element, width: 300, height: 300, version: element.version + 1 }
        : element,
    );
    const after = arrowOf(updateBoundElements(resized, new Set(["b"])));
    const boxB = resized.find((element) => element.id === "b")!;
    const bounds = getElementBounds(boxB);

    // Still stopping just short of the (now much wider) left edge.
    expect(after.x2).toBeLessThanOrEqual(bounds.x + 0.001);
    expect(after.x2).toBeGreaterThan(bounds.x - 24);
  });

  it("leaves unbound arrows alone", () => {
    const elements = makeScene();
    const before = arrowOf(elements);
    const after = arrowOf(updateBoundElements(elements, new Set(["a", "b"])));
    expect(after).toBe(before);
  });

  it("does nothing when nothing changed", () => {
    const elements = bindBoth();
    expect(updateBoundElements(elements, new Set())).toEqual(elements);
  });

  it("does not re-solve an arrow that is itself being dragged", () => {
    // Without this, dragging a bound arrow snapped it straight back every
    // frame, so it could never be moved.
    const elements = bindBoth();
    const dragged = elements.map((element) =>
      element.id === "arrow" ? translateElement(element, 0, 400) : element,
    );

    const withSkip = arrowOf(
      updateBoundElements(dragged, new Set(["arrow"]), { skipSelf: true }),
    );
    expect(withSkip.y1).toBeCloseTo(450);

    const withoutSkip = arrowOf(updateBoundElements(dragged, new Set(["arrow"])));
    expect(withoutSkip.y1).not.toBeCloseTo(450);
  });

  it("still re-solves a bound arrow when the shape it is attached to moves", () => {
    const elements = bindBoth();
    const moved = elements.map((element) =>
      element.id === "b" ? translateElement(element, 100, 0) : element,
    );
    const after = arrowOf(
      updateBoundElements(moved, new Set(["b"]), { skipSelf: true }),
    );
    expect(after.x2).toBeGreaterThan(arrowOf(elements).x2);
  });
});

describe("settleBindingsAfterMove", () => {
  it("keeps a barely-moved arrow bound and snaps it back", () => {
    const elements = bindBoth();
    const nudged = elements.map((element) =>
      element.id === "arrow" ? translateElement(element, 0, 3) : element,
    );

    const settled = arrowOf(settleBindingsAfterMove(nudged, new Set(["arrow"]), 24));
    expect(settled.startBinding).not.toBeNull();
    expect(settled.y1).toBeCloseTo(arrowOf(elements).y1);
  });

  it("releases an arrow dragged clear of both shapes and leaves it there", () => {
    const elements = bindBoth();
    const dragged = elements.map((element) =>
      element.id === "arrow" ? translateElement(element, 0, 900) : element,
    );

    const settled = arrowOf(settleBindingsAfterMove(dragged, new Set(["arrow"]), 24));
    expect(settled.startBinding).toBeNull();
    expect(settled.endBinding).toBeNull();
    expect(settled.y1).toBeCloseTo(950);
  });

  it("re-solves arrows attached to a moved shape", () => {
    const elements = bindBoth();
    const moved = elements.map((element) =>
      element.id === "b" ? translateElement(element, 250, 0) : element,
    );

    const settled = arrowOf(settleBindingsAfterMove(moved, new Set(["b"]), 24));
    expect(settled.endBinding?.elementId).toBe("b");
    expect(settled.x2).toBeGreaterThan(500);
  });
});

describe("removeStaleBindings", () => {
  it("drops bindings to deleted shapes", () => {
    const withoutB = bindBoth().filter((element) => element.id !== "b");
    const cleaned = removeStaleBindings(withoutB);

    expect(arrowOf(cleaned).endBinding).toBeNull();
    expect(arrowOf(cleaned).startBinding?.elementId).toBe("a");
  });

  it("drops reverse references to deleted arrows", () => {
    const withoutArrow = bindBoth().filter((element) => element.id !== "arrow");
    const cleaned = removeStaleBindings(withoutArrow);
    expect(cleaned.find((element) => element.id === "a")?.boundElements).toBeNull();
  });
});

describe("releaseBindingsOutsideElements", () => {
  it("releases the end that was dragged away and keeps the other", () => {
    const elements = bindBoth();
    const dragged = elements.map((element) => {
      if (element.id !== "arrow") {
        return element;
      }
      const arrow = element as LinearShape;
      return { ...arrow, x2: 1000, y2: 1000 };
    });

    const result = releaseBindingsOutsideElements(dragged, "arrow", 24);
    expect(arrowOf(result).endBinding).toBeNull();
    expect(arrowOf(result).startBinding?.elementId).toBe("a");
  });

  it("keeps both bindings when neither end moved away", () => {
    const elements = bindBoth();
    const result = releaseBindingsOutsideElements(elements, "arrow", 24);
    expect(arrowOf(result).startBinding).not.toBeNull();
    expect(arrowOf(result).endBinding).not.toBeNull();
  });
});

describe("getBoundPoint", () => {
  it("aims at the side the user pointed at", () => {
    const [, boxB] = makeScene();
    // Bound near the top of box B.
    const binding = createBinding(boxB, { x: 350, y: 10 }, 24);
    const point = getBoundPoint(binding, boxB, { x: 350, y: -200 });
    const bounds = getElementBounds(boxB);

    expect(point.y).toBeLessThanOrEqual(bounds.y + 0.001);
  });

  it("never overshoots a very close adjacent point", () => {
    const [boxA] = makeScene();
    const binding = createBinding(boxA, { x: 100, y: 50 }, 24);
    const adjacent = { x: 101, y: 50 };
    const point = getBoundPoint(binding, boxA, adjacent);

    expect(point.x).toBeLessThanOrEqual(adjacent.x + 0.001);
  });
});

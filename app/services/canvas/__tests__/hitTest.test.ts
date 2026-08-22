import { describe, expect, it } from "vitest";
import { createElement } from "../elements";
import {
  getElementAtPoint,
  getElementsInBox,
  getTransformHandleAtPoint,
  getTransformHandles,
  hitTestElement,
  hitTestElementWithSegment,
} from "../hitTest";
import type { Shape } from "../../../types/shapes";

const box = (extra: Record<string, unknown> = {}): Shape =>
  createElement("Square", { x: 0, y: 0, width: 200, height: 100, ...extra })!;

describe("hitTestElement", () => {
  it("does not hit the hollow middle of a transparent shape", () => {
    // This is the Excalidraw rule the old bounding-box test got wrong.
    expect(hitTestElement({ x: 100, y: 50 }, box(), 10)).toBe(false);
  });

  it("hits the stroke of a transparent shape", () => {
    expect(hitTestElement({ x: 100, y: 1 }, box(), 10)).toBe(true);
    expect(hitTestElement({ x: 0, y: 50 }, box(), 10)).toBe(true);
  });

  it("hits anywhere inside a filled shape", () => {
    expect(hitTestElement({ x: 100, y: 50 }, box({ fill: "#ffec99" }), 10)).toBe(
      true,
    );
  });

  it("respects the threshold just outside the stroke", () => {
    const element = box();
    expect(hitTestElement({ x: 100, y: -6 }, element, 10)).toBe(true);
    expect(hitTestElement({ x: 100, y: -60 }, element, 10)).toBe(false);
  });

  it("hits an ellipse on its curve, not at its bounding corners", () => {
    const ellipse = createElement("Circle", {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    })!;
    expect(hitTestElement({ x: 100, y: 50 }, ellipse, 6)).toBe(true);
    expect(hitTestElement({ x: 2, y: 2 }, ellipse, 6)).toBe(false);
  });

  it("hits a triangle on its slanted edges, not at its empty corners", () => {
    const triangle = createElement("Triangle", {
      x: 0,
      y: 0,
      width: 200,
      height: 200,
    })!;

    // The apex and the base are on the outline.
    expect(hitTestElement({ x: 100, y: 2 }, triangle, 6)).toBe(true);
    expect(hitTestElement({ x: 100, y: 198 }, triangle, 6)).toBe(true);
    // The bounding box's top corners are outside the shape entirely.
    expect(hitTestElement({ x: 4, y: 4 }, triangle, 6)).toBe(false);
    expect(hitTestElement({ x: 196, y: 4 }, triangle, 6)).toBe(false);
  });

  it("hits inside a filled triangle but not in the corners it does not cover", () => {
    const filled = createElement("Triangle", {
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      fill: "#ffec99",
    })!;

    expect(hitTestElement({ x: 100, y: 150 }, filled, 6)).toBe(true);
    expect(hitTestElement({ x: 10, y: 10 }, filled, 6)).toBe(false);
  });

  it("hits a line only near the line", () => {
    const line = createElement("Line", { x1: 0, y1: 0, x2: 100, y2: 100 })!;
    expect(hitTestElement({ x: 50, y: 52 }, line, 6)).toBe(true);
    expect(hitTestElement({ x: 0, y: 100 }, line, 6)).toBe(false);
  });

  it("hits text anywhere in its box", () => {
    const text = createElement("Text", {
      x: 0,
      y: 0,
      width: 80,
      height: 24,
      text: "hello",
    })!;
    expect(hitTestElement({ x: 40, y: 12 }, text, 10)).toBe(true);
  });

  it("skips deleted elements", () => {
    expect(hitTestElement({ x: 0, y: 0 }, box({ isDeleted: true }), 10)).toBe(false);
  });

  it("follows a rotated shape's real outline", () => {
    // A quarter turn swaps which sides are where.
    const turned = createElement("Square", {
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      angle: Math.PI / 2,
    })!;

    // Rotated about (100, 50), the top edge now runs vertically at x = 150.
    expect(hitTestElement({ x: 150, y: 50 }, turned, 6)).toBe(true);
    // And the point that used to be on the top edge is now in empty space.
    expect(hitTestElement({ x: 100, y: 0 }, turned, 6)).toBe(false);
  });

  it("hits a rotated filled shape inside its turned body", () => {
    const turned = createElement("Square", {
      x: 0,
      y: 0,
      width: 200,
      height: 40,
      angle: Math.PI / 2,
      fill: "#ffec99",
    })!;

    // The bar is now vertical through the centre.
    expect(hitTestElement({ x: 100, y: 90 }, turned, 4)).toBe(true);
    expect(hitTestElement({ x: 10, y: 20 }, turned, 4)).toBe(false);
  });
});

describe("getElementAtPoint", () => {
  it("returns the topmost hit", () => {
    const lower = box({ fill: "#ffec99" });
    const upper = box({ fill: "#a5d8ff" });
    expect(getElementAtPoint({ x: 100, y: 50 }, [lower, upper], 10)).toBe(upper);
  });

  it("returns null when nothing is hit", () => {
    expect(getElementAtPoint({ x: 900, y: 900 }, [box()], 10)).toBeNull();
  });

  it("clicks through a transparent shape to a filled one behind it", () => {
    const filled = createElement("Square", {
      x: 80,
      y: 30,
      width: 40,
      height: 40,
      fill: "#ffec99",
    })!;
    const transparentOnTop = box();
    expect(
      getElementAtPoint({ x: 100, y: 50 }, [filled, transparentOnTop], 10),
    ).toBe(filled);
  });
});

describe("getElementsInBox", () => {
  it("selects anything the marquee touches", () => {
    const a = box();
    const b = createElement("Square", {
      x: 500,
      y: 500,
      width: 10,
      height: 10,
    })!;

    const selected = getElementsInBox(
      { x: -10, y: -10, width: 60, height: 60 },
      [a, b],
    );

    expect(selected).toEqual([a]);
  });
});

describe("transform handles", () => {
  it("gives a box eight resize handles plus a rotation grip", () => {
    const bounds = { x: 0, y: 0, width: 200, height: 100 };
    const handles = getTransformHandles([box()], bounds, 1);

    expect(handles).toHaveLength(9);
    expect(handles.filter((handle) => handle.name === "rotate")).toHaveLength(1);
  });

  it("drops the side handles on a tiny selection but keeps the grip", () => {
    const bounds = { x: 0, y: 0, width: 6, height: 6 };
    const handles = getTransformHandles([box()], bounds, 1);

    expect(handles).toHaveLength(5);
    expect(handles.some((handle) => handle.name === "rotate")).toBe(true);
  });

  it("puts the rotation grip above the top edge", () => {
    const bounds = { x: 0, y: 0, width: 200, height: 100 };
    const grip = getTransformHandles([box()], bounds, 1).find(
      (handle) => handle.name === "rotate",
    )!;

    expect(grip.center.x).toBeCloseTo(100);
    expect(grip.center.y).toBeLessThan(0);
  });

  it("gives a single linear element endpoint and insert handles", () => {
    const line = createElement("Arrow", { x1: 0, y1: 0, x2: 50, y2: 50 })!;
    const handles = getTransformHandles([line], getBounds(line), 1);
    // Two ends, plus a phantom handle in the middle to pull a bend out of.
    expect(handles.map((handle) => handle.name)).toEqual([
      "start",
      "end",
      "add-0",
    ]);
  });

  it("offers no waypoint handles on an elbow, whose path the router owns", () => {
    const elbow = createElement("Arrow", {
      x1: 0,
      y1: 0,
      x2: 200,
      y2: 200,
      edgeStyle: "elbow",
    })!;
    const handles = getTransformHandles([elbow], getBounds(elbow), 1);
    expect(handles.map((handle) => handle.name)).toEqual(["start", "end"]);
  });

  it("exposes a handle for each waypoint once one exists", () => {
    const bent = createElement("Arrow", {
      x1: 0,
      y1: 0,
      x2: 200,
      y2: 0,
      midPoints: [100, 80],
    })!;
    const names = getTransformHandles([bent], getBounds(bent), 1).map(
      (handle) => handle.name,
    );

    expect(names).toContain("mid-0");
    // One phantom per segment.
    expect(names).toContain("add-0");
    expect(names).toContain("add-1");
  });

  it("finds the handle under the pointer", () => {
    const element = box();
    const bounds = { x: 0, y: 0, width: 200, height: 100 };
    expect(getTransformHandleAtPoint({ x: 0, y: 0 }, [element], bounds, 1)).toBe(
      "nw",
    );
    expect(
      getTransformHandleAtPoint({ x: 200, y: 100 }, [element], bounds, 1),
    ).toBe("se");
    expect(
      getTransformHandleAtPoint({ x: 100, y: 50 }, [element], bounds, 1),
    ).toBeNull();
  });

  it("turns the handles with a rotated element", () => {
    // Half a turn puts the north-west handle where the south-east one was.
    const bounds = { x: 0, y: 0, width: 200, height: 100 };
    const turned = createElement("Square", {
      ...bounds,
      angle: Math.PI,
    })!;

    const handles = getTransformHandles([turned], bounds, 1);
    const nw = handles.find((handle) => handle.name === "nw")!;

    expect(nw.center.x).toBeCloseTo(200);
    expect(nw.center.y).toBeCloseTo(100);
  });

  it("finds a rotated handle where it is drawn, not where it would be upright", () => {
    const bounds = { x: 0, y: 0, width: 200, height: 100 };
    const turned = createElement("Square", { ...bounds, angle: Math.PI })!;

    // The upright north-west position no longer holds that handle.
    expect(
      getTransformHandleAtPoint({ x: 0, y: 0 }, [turned], bounds, 1),
    ).toBe("se");
    expect(
      getTransformHandleAtPoint({ x: 200, y: 100 }, [turned], bounds, 1),
    ).toBe("nw");
  });

  it("keeps handles the same size on screen as the zoom changes", () => {
    const bounds = { x: 0, y: 0, width: 200, height: 100 };
    const atOne = getTransformHandles([box()], bounds, 1)[0];
    const atFour = getTransformHandles([box()], bounds, 4)[0];
    expect(atFour.width).toBeCloseTo(atOne.width / 4);
  });
});

describe("hitTestElementWithSegment", () => {
  it("catches an element the eraser swept past between samples", () => {
    const element = box();
    // Neither endpoint touches the top edge, but the segment crosses it.
    const from = { x: 100, y: -40 };
    const to = { x: 100, y: 40 };

    expect(hitTestElement(from, element, 8)).toBe(false);
    expect(hitTestElement(to, element, 8)).toBe(false);
    expect(hitTestElementWithSegment(from, to, element, 8)).toBe(true);
  });
});

function getBounds(element: Shape) {
  return {
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
  };
}

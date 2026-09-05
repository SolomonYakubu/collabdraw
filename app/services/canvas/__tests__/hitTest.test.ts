import { describe, expect, it } from "vitest";
import { createElement } from "../elements";
import {
  distanceToElementOutline,
  getElementAtPoint,
  getElementsAtPoint,
  getElementsInBox,
  getHandleCursor,
  getHandleIndex,
  getTransformHandleAtPoint,
  getTransformHandles,
  hitTestElement,
  hitTestElementWithSegment,
  isInsertHandle,
  isWaypointHandle,
} from "../hitTest";
import type { Shape, TransformHandle } from "../../../types/shapes";

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

  it("grabs the hollow middle of a transparent shape when interior is included", () => {
    // Selection passes includeInterior so a shape can be dragged from its centre,
    // while the eraser and click-through paths keep the stroke-only rule.
    expect(hitTestElement({ x: 100, y: 50 }, box(), 10, true)).toBe(true);
    // A transparent triangle: inside the slanted body is grabbable, the empty
    // bounding corners are still not.
    const triangle = createElement("Triangle", {
      x: 0,
      y: 0,
      width: 200,
      height: 200,
    })!;
    expect(hitTestElement({ x: 100, y: 150 }, triangle, 6, true)).toBe(true);
    expect(hitTestElement({ x: 10, y: 10 }, triangle, 6, true)).toBe(false);
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

  it("hits a freehand stroke along the path it was drawn, not its box", () => {
    const stroke = createElement("Freehand", {
      points: [0, 0, 50, 100, 100, 0],
    })!;

    expect(hitTestElement({ x: 25, y: 50 }, stroke, 6)).toBe(true);
    // The middle of the V is inside the bounding box but nowhere near the ink.
    expect(hitTestElement({ x: 50, y: 10 }, stroke, 6)).toBe(false);
  });

  it("hits anywhere inside a filled ellipse", () => {
    const filled = createElement("Circle", {
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      fill: "#ffec99",
    })!;

    expect(hitTestElement({ x: 100, y: 50 }, filled, 6)).toBe(true);
    // Its bounding corner is still outside the curve.
    expect(hitTestElement({ x: 4, y: 4 }, filled, 6)).toBe(false);
  });

  it("hits inside a filled diamond but not in the corners it cuts off", () => {
    const filled = createElement("Diamond", {
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      fill: "#ffec99",
    })!;

    expect(hitTestElement({ x: 100, y: 100 }, filled, 6)).toBe(true);
    // A diamond only encloses half its box, so its bounding corners are empty.
    expect(hitTestElement({ x: 10, y: 10 }, filled, 6)).toBe(false);
  });

  it("misses an element whose tool it does not recognise", () => {
    /*
     * A scene loaded from an older file or another build can carry a tool this
     * version has no geometry for. Neither the outline nor the interior test
     * knows what to do with it, and both must say "no hit" rather than throw —
     * one unknown element would otherwise break every click on the canvas.
     */
    const alien = { ...box({ fill: "#ffec99" }), tool: "Hexagon" } as unknown as Shape;

    expect(distanceToElementOutline({ x: 0, y: 0 }, alien)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(hitTestElement({ x: 100, y: 50 }, alien, 10)).toBe(false);
    expect(hitTestElement({ x: 100, y: 50 }, alien, 10, true)).toBe(false);
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

describe("getElementsAtPoint", () => {
  it("returns every hit, topmost first", () => {
    // The click-through cycle needs the whole stack under the cursor, not just
    // the winner, so a repeated click can step down through overlapping shapes.
    const lower = box({ fill: "#ffec99" });
    const middle = createElement("Square", {
      x: 80,
      y: 30,
      width: 40,
      height: 40,
      fill: "#a5d8ff",
    })!;
    const upper = box({ fill: "#b2f2bb" });

    expect(
      getElementsAtPoint({ x: 100, y: 50 }, [lower, middle, upper], 10),
    ).toEqual([upper, middle, lower]);
  });

  it("leaves out the shapes the point only appears to be inside", () => {
    // Same transparent-fill rule as a single hit: without includeInterior only
    // the shape whose stroke is nearby comes back.
    const hollow = box();
    const filledBehind = createElement("Square", {
      x: 80,
      y: 30,
      width: 40,
      height: 40,
      fill: "#ffec99",
    })!;

    expect(
      getElementsAtPoint({ x: 100, y: 50 }, [filledBehind, hollow], 10),
    ).toEqual([filledBehind]);
    expect(
      getElementsAtPoint({ x: 100, y: 50 }, [filledBehind, hollow], 10, true),
    ).toEqual([hollow, filledBehind]);
  });

  it("returns an empty array when nothing is under the point", () => {
    expect(getElementsAtPoint({ x: 900, y: 900 }, [box()], 10)).toEqual([]);
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

  it("ignores deleted elements the marquee sweeps over", () => {
    // Deleted elements stay in the array until history is pruned, so a marquee
    // over empty canvas would otherwise select something invisible.
    const gone = box({ isDeleted: true });
    expect(
      getElementsInBox({ x: -10, y: -10, width: 400, height: 400 }, [gone]),
    ).toEqual([]);
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

  it("keeps a mixed selection's handles upright and box-shaped", () => {
    /*
     * Two elements have no single angle to turn the frame by, so the handles
     * stay axis-aligned — and a selection that happens to contain a line still
     * gets the eight box handles rather than that line's endpoints.
     */
    const bounds = { x: 0, y: 0, width: 200, height: 100 };
    const turned = createElement("Square", { ...bounds, angle: Math.PI / 4 })!;
    const line = createElement("Line", { x1: 0, y1: 0, x2: 200, y2: 100 })!;

    const handles = getTransformHandles([turned, line], bounds, 1);
    const names = handles.map((handle) => handle.name);

    expect(names).not.toContain("start");
    expect(names).toContain("nw");
    expect(handles.find((handle) => handle.name === "nw")!.center).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("returns a phantom handle when it is the only thing under the pointer", () => {
    // Mid-segment is nowhere near either end, so the phantom is the only hit —
    // the branch that lets a bend be pulled out of the middle of a line.
    const line = createElement("Line", { x1: 0, y1: 0, x2: 200, y2: 200 })!;
    expect(
      getTransformHandleAtPoint({ x: 100, y: 100 }, [line], getBounds(line), 1),
    ).toBe("add-0");
  });

  it("prefers a real handle to a phantom sharing the same spot", () => {
    /*
     * A line folded back on itself — both ends in the same place, a bend either
     * side — puts the middle segment's phantom exactly on the endpoint handles.
     * Dragging there must move the end rather than insert a fourth bend, which
     * is why anything concrete wins the tie.
     */
    const folded = createElement("Line", {
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 0,
      midPoints: [0, 40, 0, -40],
    })!;
    const bounds = getBounds(folded);
    const phantom = getTransformHandles([folded], bounds, 1).find(
      (handle) => handle.name === "add-1",
    )!;

    expect(phantom.center).toEqual({ x: 0, y: 0 });
    expect(getTransformHandleAtPoint(phantom.center, [folded], bounds, 1)).toBe(
      "start",
    );
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

  it("reports a miss for a stroke that never comes near the element", () => {
    expect(
      hitTestElementWithSegment(
        { x: 400, y: 400 },
        { x: 600, y: 600 },
        box(),
        8,
      ),
    ).toBe(false);
  });

  it("still samples a stationary pointer", () => {
    // A press with no movement is a zero-length segment; `steps` must not come
    // out as 0 and skip the loop, or a click-to-erase would do nothing.
    const element = box();
    expect(
      hitTestElementWithSegment({ x: 100, y: 0 }, { x: 100, y: 0 }, element, 8),
    ).toBe(true);
  });

  it("never erases an already-deleted element", () => {
    expect(
      hitTestElementWithSegment(
        { x: 100, y: -40 },
        { x: 100, y: 40 },
        box({ isDeleted: true }),
        8,
      ),
    ).toBe(false);
  });
});

describe("handle helpers", () => {
  it("tells the three kinds of linear handle apart", () => {
    expect(isWaypointHandle("mid-2")).toBe(true);
    expect(isWaypointHandle("add-2")).toBe(false);
    expect(isWaypointHandle("nw")).toBe(false);

    expect(isInsertHandle("add-0")).toBe(true);
    expect(isInsertHandle("mid-0")).toBe(false);
    expect(isInsertHandle("rotate")).toBe(false);
  });

  it("reads the index off a numbered handle", () => {
    expect(getHandleIndex("mid-0")).toBe(0);
    expect(getHandleIndex("add-3")).toBe(3);
    expect(getHandleIndex("mid-12")).toBe(12);
  });

  it("returns -1 for a handle that carries no index", () => {
    // The drag code indexes `midPoints` with this, so a NaN would splice at an
    // unpredictable position instead of being rejected.
    expect(getHandleIndex("nw")).toBe(-1);
    expect(getHandleIndex("rotate")).toBe(-1);
  });

  it("gives every handle the cursor that describes what it will do", () => {
    const cursors: Array<[TransformHandle, string]> = [
      ["nw", "nwse-resize"],
      ["se", "nwse-resize"],
      ["ne", "nesw-resize"],
      ["sw", "nesw-resize"],
      ["n", "ns-resize"],
      ["s", "ns-resize"],
      ["e", "ew-resize"],
      ["w", "ew-resize"],
      ["rotate", "grab"],
      ["start", "move"],
      ["end", "move"],
      ["mid-0", "move"],
      // A phantom handle creates a bend rather than moving one, so it reads as
      // a copy the way Excalidraw's does.
      ["add-1", "copy"],
    ];

    for (const [handle, cursor] of cursors) {
      expect(getHandleCursor(handle)).toBe(cursor);
    }
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

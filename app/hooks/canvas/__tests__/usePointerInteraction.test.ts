// @vitest-environment jsdom
/**
 * The pointer state machine — the one place that decides what a press *means*.
 *
 * The maths it delegates to is covered next door in `interactions/__tests__`;
 * what is only testable here is the arbitration. Every gesture starts as the
 * same `pointerdown`, and the branch it takes depends on the tool, the modifier
 * keys, what lies under the pointer, how many fingers are down and what the
 * previous gesture left behind. The failures that follow from getting that wrong
 * are the ones that make an editor feel broken rather than wrong: a shape that
 * cannot be grabbed by its middle, a click that leaves a zero-sized element
 * behind, a second finger that commits half a drag, a cancelled gesture that
 * leaves the scene bent.
 *
 * Two mechanical notes. The canvas is a stub — the hook only ever asks it for
 * its rect and for pointer capture — and with the default viewport (zoom 1, no
 * scroll) at a rect anchored on the origin, client coordinates *are* world
 * coordinates, so the numbers in these tests read as positions on the canvas.
 * And `applyElements` is the same faithful fake used by the interaction tests:
 * it runs the updater against the ref and writes back synchronously, because
 * two calls in one gesture have to see each other's work.
 */
import { useRef, useState } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  usePointerInteraction,
  type PointerInteraction,
} from "../usePointerInteraction";
import { createElement } from "../../../services/canvas/elements";
import { getTransformHandles } from "../../../services/canvas/hitTest";
import { getSelectionBounds } from "../../../services/canvas/transform";
import { DEFAULT_STYLE } from "../../../types/shapes";
import type {
  ElementStyle,
  LinearShape,
  Point,
  Shape,
  ToolType,
  TransformHandle,
  Viewport,
} from "../../../types/shapes";
import type { ApplyOptions, ElementsUpdater } from "../useScene";

const box = (id: string, attrs: Record<string, unknown> = {}): Shape =>
  createElement("Square", {
    id,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    ...attrs,
  })!;

const arrow = (id: string, attrs: Record<string, unknown> = {}): LinearShape =>
  createElement("Arrow", {
    id,
    x1: 0,
    y1: 100,
    x2: 200,
    y2: 100,
    ...attrs,
  }) as LinearShape;

const line = (id: string, attrs: Record<string, unknown> = {}): LinearShape =>
  createElement("Line", {
    id,
    x1: 0,
    y1: 100,
    x2: 200,
    y2: 100,
    ...attrs,
  }) as LinearShape;

const text = (id: string, attrs: Record<string, unknown> = {}): Shape =>
  createElement("Text", {
    id,
    x: 0,
    y: 0,
    width: 60,
    height: 24,
    text: "hello",
    ...attrs,
  })!;

interface Overrides {
  tool?: ToolType;
  toolLocked?: boolean;
  style?: ElementStyle;
  selectedIds?: string[];
  viewport?: Viewport;
  /** The canvas is rarely at the top-left of the page; a test can say so. */
  rect?: { left: number; top: number };
}

/** Everything `Canvas` owns and hands to the hook, faked and recorded. */
const makeHarness = (
  elements: readonly Shape[] = [],
  overrides: Overrides = {},
) => {
  const captured = new Set<number>();
  const captures: number[] = [];
  const releases: number[] = [];
  const origin = overrides.rect ?? { left: 0, top: 0 };

  const canvas = {
    setPointerCapture(pointerId: number) {
      captured.add(pointerId);
      captures.push(pointerId);
    },
    hasPointerCapture(pointerId: number) {
      return captured.has(pointerId);
    },
    releasePointerCapture(pointerId: number) {
      captured.delete(pointerId);
      releases.push(pointerId);
    },
    getBoundingClientRect: () => ({
      ...origin,
      width: 1200,
      height: 800,
      right: origin.left + 1200,
      bottom: origin.top + 800,
      x: origin.left,
      y: origin.top,
    }),
  };

  const harness = {
    canvasRef: {
      current: canvas as unknown as HTMLCanvasElement | null,
    },
    elementsRef: { current: [...elements] as Shape[] },
    spacePressedRef: { current: false },
    captures,
    releases,
    toolLocked: overrides.toolLocked ?? false,

    initialTool: overrides.tool ?? ("Select" as ToolType),
    initialStyle: overrides.style ?? DEFAULT_STYLE,
    initialSelectedIds: overrides.selectedIds ?? [],
    initialViewport: overrides.viewport ?? { zoom: 1, scroll: { x: 0, y: 0 } },

    /** Mirrors of the state the wrapper holds, for the assertions. */
    tool: overrides.tool ?? ("Select" as ToolType),
    selectedIds: overrides.selectedIds ?? [],
    viewport: overrides.viewport ?? { zoom: 1, scroll: { x: 0, y: 0 } },

    applied: [] as Array<{ options: ApplyOptions; result: Shape[] }>,
    selections: [] as string[][],
    tools: [] as ToolType[],
    onEditText: vi.fn<(id: string) => void>(),
    onCreateText: vi.fn<(point: Point, containerId?: string | null) => void>(),
    onPendingElementChange: vi.fn<(element: Shape | null) => void>(),

    applyElements(updater: ElementsUpdater, options: ApplyOptions = {}) {
      const next =
        typeof updater === "function"
          ? updater(harness.elementsRef.current)
          : updater;
      harness.elementsRef.current = next;
      harness.applied.push({ options, result: next });
      return next;
    },

    find(id: string): Shape {
      const element = harness.elementsRef.current.find(
        (item) => item.id === id,
      );
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

    /** Applied calls that push an undo step — `commit: false` is the default. */
    get commits() {
      return harness.applied.filter(({ options }) => options.commit !== false)
        .length;
    },
  };

  return harness;
};

type Harness = ReturnType<typeof makeHarness>;

/** The hook's own surface, plus two handles for the state `Canvas` would own. */
interface Api extends PointerInteraction {
  chooseTool: (tool: ToolType) => void;
  chooseStyle: (style: ElementStyle) => void;
}

type Result = { current: Api };

/**
 * Mirrors `Canvas`: tool, style, selection and viewport are React state, and the
 * hook drives them through the setters it is given. Keeping them as real state
 * is what makes the loop under test the real one — a press that selects has to
 * be visible to the press after it.
 */
const setup = (harness: Harness) =>
  renderHook<Api, unknown>(() => {
    const [tool, setTool] = useState<ToolType>(harness.initialTool);
    const [style, setStyle] = useState<ElementStyle>(harness.initialStyle);
    const [selectedIds, setSelectedIds] = useState<string[]>(
      harness.initialSelectedIds,
    );
    const [viewport, setViewport] = useState<Viewport>(harness.initialViewport);

    const viewportRef = useRef(viewport);
    viewportRef.current = viewport;

    harness.tool = tool;
    harness.selectedIds = selectedIds;
    harness.viewport = viewport;

    const interaction = usePointerInteraction({
      canvasRef: harness.canvasRef,
      elementsRef: harness.elementsRef,
      applyElements: harness.applyElements,
      viewportRef,
      setViewport,
      tool,
      setTool: (next) => {
        harness.tools.push(next);
        setTool(next);
      },
      toolLocked: harness.toolLocked,
      style,
      selectedIds,
      setSelectedIds: (ids) => {
        harness.selections.push(ids);
        setSelectedIds(ids);
      },
      spacePressedRef: harness.spacePressedRef,
      onEditText: harness.onEditText,
      onCreateText: harness.onCreateText,
      onPendingElementChange: harness.onPendingElementChange,
    });

    return { ...interaction, chooseTool: setTool, chooseStyle: setStyle };
  });

interface Init {
  button?: number;
  pointerId?: number;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

type FakeEvent = React.PointerEvent<HTMLCanvasElement> & {
  preventDefault: ReturnType<typeof vi.fn>;
};

/** A synthetic pointer event with only the fields the hook reads. */
const at = (clientX: number, clientY: number, init: Init = {}): FakeEvent =>
  ({
    pointerId: 1,
    button: 0,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...init,
    clientX,
    clientY,
    preventDefault: vi.fn(),
  }) as unknown as FakeEvent;

const down = (result: Result, x: number, y: number, init: Init = {}) => {
  const event = at(x, y, init);
  act(() => result.current.handlers.onPointerDown(event));
  return event;
};

const move = (result: Result, x: number, y: number, init: Init = {}) => {
  const event = at(x, y, init);
  act(() => result.current.handlers.onPointerMove(event));
  return event;
};

const up = (result: Result, x: number, y: number, init: Init = {}) => {
  const event = at(x, y, init);
  act(() => result.current.handlers.onPointerUp(event));
  return event;
};

const cancelPointer = (result: Result, init: Init = {}) =>
  act(() => result.current.handlers.onPointerCancel(at(0, 0, init)));

const doubleClick = (result: Result, x: number, y: number) => {
  const event = at(x, y);
  act(() =>
    result.current.handlers.onDoubleClick(
      event as unknown as React.MouseEvent<HTMLCanvasElement>,
    ),
  );
  return event;
};

/** press, drag, release — the whole of a gesture in one line. */
const drag = (result: Result, from: Point, to: Point, init: Init = {}) => {
  down(result, from.x, from.y, init);
  move(result, to.x, to.y, init);
  up(result, to.x, to.y, init);
};

/**
 * Where a transform handle actually is. Computed rather than written down: the
 * handles move with the selection, and a test that pressed a hard-coded point
 * would quietly stop testing the handle at all.
 */
const handleAt = (
  harness: Harness,
  name: TransformHandle,
  ids: readonly string[],
): Point => {
  const selected = harness.elementsRef.current.filter((element) =>
    ids.includes(element.id),
  );
  const bounds = getSelectionBounds(selected);
  if (!bounds) {
    throw new Error("nothing selected to take a handle from");
  }
  const handle = getTransformHandles(
    selected,
    bounds,
    harness.viewport.zoom,
  ).find((candidate) => candidate.name === name);
  if (!handle) {
    throw new Error(`no ${name} handle on this selection`);
  }
  return handle.center;
};

/** Spread a computed point into the two arguments `down` and `move` take. */
const atPoint = (point: Point): [number, number] => [point.x, point.y];

afterEach(cleanup);

describe("the press itself", () => {
  it("captures the pointer and keeps the event to itself", () => {
    // Without capture, a fast drag that leaves the canvas stops sending moves and
    // the gesture is left half-applied with no release to finish it.
    const harness = makeHarness();
    const { result } = setup(harness);

    const event = down(result, 10, 10);

    expect(harness.captures).toEqual([1]);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("releases the capture when the gesture ends", () => {
    const harness = makeHarness();
    const { result } = setup(harness);

    down(result, 10, 10);
    up(result, 10, 10);

    expect(harness.releases).toEqual([1]);
  });

  it("leaves the right button to the context menu", () => {
    // Capturing it swallows the menu, and starting a marquee underneath would
    // clear the very selection the menu is about to act on.
    const harness = makeHarness([box("a")], { tool: "Square" });
    const { result } = setup(harness);

    const event = down(result, 10, 10, { button: 2 });
    move(result, 60, 60, { button: 2 });

    expect(harness.captures).toEqual([]);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(result.current.pendingElement).toBeNull();
  });

  it("ignores the back and forward buttons", () => {
    const harness = makeHarness([], { tool: "Square" });
    const { result } = setup(harness);

    drag(result, { x: 10, y: 10 }, { x: 60, y: 60 }, { button: 3 });

    expect(harness.applied).toEqual([]);
    expect(result.current.pendingElement).toBeNull();
  });

  it("does nothing once the canvas has gone", () => {
    const harness = makeHarness([], { tool: "Square" });
    const { result } = setup(harness);
    harness.canvasRef.current = null;

    drag(result, { x: 10, y: 10 }, { x: 60, y: 60 });

    expect(harness.captures).toEqual([]);
    expect(harness.applied).toEqual([]);
  });
});

/**
 * Panning is available from every tool, because reaching for the hand tool in
 * the middle of drawing is exactly when you least want to change tools.
 */
describe("panning", () => {
  it("pans with the space bar held, whatever the tool", () => {
    const harness = makeHarness([], { tool: "Square" });
    const { result } = setup(harness);
    harness.spacePressedRef.current = true;

    drag(result, { x: 10, y: 10 }, { x: 40, y: 30 });

    expect(harness.viewport.scroll).toEqual({ x: 30, y: 20 });
    expect(harness.applied).toEqual([]);
  });

  it("pans with the middle mouse button", () => {
    const harness = makeHarness([], { tool: "Square" });
    const { result } = setup(harness);

    drag(result, { x: 10, y: 10 }, { x: 0, y: 10 }, { button: 1 });

    expect(harness.viewport.scroll).toEqual({ x: -10, y: 0 });
    expect(harness.applied).toEqual([]);
  });

  it("pans with the hand tool", () => {
    const harness = makeHarness([box("a")], { tool: "Pan", selectedIds: ["a"] });
    const { result } = setup(harness);

    // Straight over a selected shape's own handle, which the hand tool outranks.
    drag(result, { x: 100, y: 100 }, { x: 120, y: 100 });

    expect(harness.viewport.scroll).toEqual({ x: 20, y: 0 });
    expect(harness.find("a")).toMatchObject({ x: 0, y: 0, width: 100 });
  });

  it("keeps the scene under the pointer when zoomed in", () => {
    // Scroll is in world units, so a 40px drag at 2x is 20 world units. Without
    // the division the scene slides away from the hand that is dragging it.
    const harness = makeHarness([], {
      tool: "Pan",
      viewport: { zoom: 2, scroll: { x: 0, y: 0 } },
    });
    const { result } = setup(harness);

    drag(result, { x: 0, y: 0 }, { x: 40, y: 0 });

    expect(harness.viewport.scroll).toEqual({ x: 20, y: 0 });
  });
});

describe("two fingers", () => {
  it("zooms about the midpoint and pans with it", () => {
    /*
     * Fingers at 0 and 100 spread to 0 and 200: twice the distance, so twice the
     * zoom. The world point under the midpoint stays pinned, which is what
     * `zoomAtPoint` is for, and the 50px the midpoint travelled is then 25 world
     * units at the new zoom.
     */
    const harness = makeHarness();
    const { result } = setup(harness);

    down(result, 0, 0);
    down(result, 100, 0, { pointerId: 2 });
    move(result, 200, 0, { pointerId: 2 });

    expect(harness.viewport).toEqual({ zoom: 2, scroll: { x: -25, y: 0 } });
  });

  it("throws away the shape that was being drawn", () => {
    // The first finger of a two-finger gesture lands first, so every pinch starts
    // as a one-finger press — with a drawing tool, that press begins a shape.
    const harness = makeHarness([], { tool: "Square" });
    const { result } = setup(harness);

    down(result, 10, 10);
    move(result, 60, 60);
    expect(result.current.pendingElement).not.toBeNull();

    down(result, 300, 300, { pointerId: 2 });

    expect(result.current.pendingElement).toBeNull();

    up(result, 300, 300, { pointerId: 2 });
    up(result, 60, 60);

    expect(harness.elementsRef.current).toEqual([]);
    expect(harness.applied).toEqual([]);
  });

  it("puts back whatever a half-finished drag had moved", () => {
    // Otherwise the shape keeps the position it happened to have when the second
    // finger landed — a move nobody asked for and no undo step to take it back.
    // The bystander is here to be left alone: the revert walks the whole scene,
    // and rebuilding the elements it does not restore would send every one of
    // them to the peers as a change.
    const bystander = box("b", { x: 400 });
    const harness = makeHarness([box("a"), bystander], { selectedIds: ["a"] });
    const { result } = setup(harness);

    down(result, 50, 50);
    move(result, 150, 50);
    expect(harness.find("a").x).toBe(100);

    down(result, 400, 400, { pointerId: 2 });

    expect(harness.find("a").x).toBe(0);
    expect(harness.find("b")).toBe(bystander);
    expect(harness.lastApplied.options).toEqual({
      commit: false,
      broadcast: "elements",
    });
    expect(harness.commits).toBe(0);
  });

  it("stays idle until every finger has lifted", () => {
    // Resuming on the remaining finger would carry on from the gesture the pinch
    // interrupted, whose origin is now meaningless.
    const harness = makeHarness();
    const { result } = setup(harness);

    down(result, 0, 0);
    down(result, 100, 0, { pointerId: 2 });
    move(result, 200, 0, { pointerId: 2 });

    up(result, 0, 0);
    move(result, 600, 300, { pointerId: 2 });

    expect(harness.viewport).toEqual({ zoom: 2, scroll: { x: -25, y: 0 } });
    expect(result.current.visuals.marquee).toBeNull();
  });
});

describe("drawing a shape", () => {
  it("draws from the press to the release and commits once", () => {
    const harness = makeHarness([], { tool: "Square" });
    const { result } = setup(harness);

    down(result, 10, 10);
    // The old selection gets out of the way, so the handles do not sit over the
    // shape being drawn.
    expect(harness.selections).toEqual([[]]);

    move(result, 60, 40);
    expect(result.current.pendingElement).toMatchObject({
      x: 10,
      y: 10,
      width: 50,
      height: 30,
    });
    // Nothing is in the scene until the release: an abandoned draw leaves no
    // undo step, and peers see the pending element instead.
    expect(harness.applied).toEqual([]);
    expect(harness.onPendingElementChange).toHaveBeenLastCalledWith(
      result.current.pendingElement,
    );

    up(result, 60, 40);

    const drawn = harness.elementsRef.current[0];
    expect(drawn).toMatchObject({
      tool: "Square",
      x: 10,
      y: 10,
      width: 50,
      height: 30,
    });
    expect(harness.lastApplied.options).toEqual({ changedIds: [drawn.id] });
    expect(harness.commits).toBe(1);
    expect(result.current.pendingElement).toBeNull();
    expect(harness.onPendingElementChange).toHaveBeenLastCalledWith(null);
    expect(harness.selectedIds).toEqual([drawn.id]);
  });

  it("returns to the select tool, so the shape can be adjusted", () => {
    const harness = makeHarness([], { tool: "Square" });
    const { result } = setup(harness);

    drag(result, { x: 10, y: 10 }, { x: 60, y: 40 });

    expect(harness.tools).toEqual(["Select"]);
  });

  it("keeps the tool when the tool is locked", () => {
    const harness = makeHarness([], { tool: "Square", toolLocked: true });
    const { result } = setup(harness);

    drag(result, { x: 10, y: 10 }, { x: 60, y: 40 });

    expect(harness.tools).toEqual([]);
    expect(harness.tool).toBe("Square");
  });

  it("leaves nothing behind when the press barely moved", () => {
    // A stray click with a shape tool. Left in, a 1px element is invisible but
    // still selectable, still exported and still counted by "is the board empty".
    const harness = makeHarness([], { tool: "Square" });
    const { result } = setup(harness);

    drag(result, { x: 10, y: 10 }, { x: 12, y: 11 });

    expect(harness.elementsRef.current).toEqual([]);
    expect(harness.applied).toEqual([]);
    expect(result.current.pendingElement).toBeNull();
  });

  it("holds shift to keep it square", () => {
    const harness = makeHarness([], { tool: "Square" });
    const { result } = setup(harness);

    down(result, 0, 0);
    move(result, 100, 40, { shiftKey: true });

    expect(result.current.pendingElement).toMatchObject({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
  });

  it("holds shift to keep it square, drawn backwards", () => {
    // Dragging up and to the left has to anchor the square on the press, not on
    // the corner `normalizeBox` happened to produce — anchoring the wrong corner
    // makes the square jump out from under the pointer as it is drawn.
    const harness = makeHarness([], { tool: "Square" });
    const { result } = setup(harness);

    down(result, 100, 100);
    move(result, 60, 40, { shiftKey: true });

    expect(result.current.pendingElement).toMatchObject({
      x: 40,
      y: 40,
      width: 60,
      height: 60,
    });
  });

  it("holds alt to grow out from the press", () => {
    const harness = makeHarness([], { tool: "Square" });
    const { result } = setup(harness);

    down(result, 50, 50);
    move(result, 100, 80, { altKey: true });

    expect(result.current.pendingElement).toMatchObject({
      x: 0,
      y: 20,
      width: 100,
      height: 60,
    });
  });

  it("lands under the pointer on a scrolled, zoomed, offset canvas", () => {
    // Three transforms have to be undone at once — the canvas's own position on
    // the page, the zoom and the scroll. Getting any of them wrong puts the shape
    // somewhere else entirely, and only ever on a canvas that is not at the
    // origin, which is why it is worth pinning down here.
    const harness = makeHarness([], {
      tool: "Square",
      viewport: { zoom: 2, scroll: { x: 10, y: 5 } },
      rect: { left: 40, top: 20 },
    });
    const { result } = setup(harness);

    drag(result, { x: 140, y: 120 }, { x: 240, y: 220 });

    expect(harness.elementsRef.current[0]).toMatchObject({
      x: 40,
      y: 45,
      width: 50,
      height: 50,
    });
  });
});

describe("freehand", () => {
  const points = (element: Shape | null) =>
    (element as Shape & { points: number[] } | null)?.points;

  it("records the pointer's path as it goes", () => {
    const harness = makeHarness([], { tool: "Freehand" });
    const { result } = setup(harness);

    down(result, 10, 10);
    move(result, 20, 20);
    move(result, 30, 25);

    expect(points(result.current.pendingElement)).toEqual([
      10, 10, 20, 20, 30, 25,
    ]);
  });

  it("drops jitter below the sampling distance", () => {
    // Every sampled point is stored, redrawn and broadcast; a hand resting on the
    // trackpad would otherwise fill the stroke with thousands of identical points.
    const harness = makeHarness([], { tool: "Freehand" });
    const { result } = setup(harness);

    down(result, 10, 10);
    move(result, 10.5, 10);
    expect(points(result.current.pendingElement)).toEqual([10, 10]);

    move(result, 20, 10);
    expect(points(result.current.pendingElement)).toEqual([10, 10, 20, 10]);
  });

  it("leaves nothing behind for a single dot", () => {
    const harness = makeHarness([], { tool: "Freehand" });
    const { result } = setup(harness);

    down(result, 10, 10);
    up(result, 10, 10);

    expect(harness.elementsRef.current).toEqual([]);
    expect(result.current.pendingElement).toBeNull();
  });

  it("simplifies the stroke it commits", () => {
    // A stroke arrives as one point per pointer event; keeping them all makes the
    // scene grow without bound and every peer redraw slower for no visible gain.
    const harness = makeHarness([], { tool: "Freehand" });
    const { result } = setup(harness);

    down(result, 0, 0);
    move(result, 10, 0);
    move(result, 20, 0);
    move(result, 30, 0);
    up(result, 30, 0);

    // The straight run between the ends carries no shape, so it goes.
    expect(points(harness.elementsRef.current[0])).toEqual([0, 0, 30, 0]);
    expect(harness.elementsRef.current[0]).toMatchObject({
      x: 0,
      width: 30,
    });
  });
});

describe("drawing a line or an arrow", () => {
  it("draws from the press to the release", () => {
    const harness = makeHarness([], { tool: "Arrow" });
    const { result } = setup(harness);

    drag(result, { x: 0, y: 0 }, { x: 100, y: 50 });

    expect(harness.elementsRef.current[0]).toMatchObject({
      tool: "Arrow",
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 50,
    });
  });

  it("puts the start exactly on a corner it was aimed at", () => {
    /*
     * Joining shape to shape is the point of a diagram; "nearly on the corner"
     * shows as a visible gap, and the join comes apart as soon as either end moves.
     * Drawn with the line tool, whose ends stay where they are put — an arrow's
     * start would be taken over by the binding it makes to the same shape.
     */
    const harness = makeHarness([box("target", { x: 100, y: 100 })], {
      tool: "Line",
    });
    const { result } = setup(harness);

    down(result, 105, 103);
    expect(result.current.visuals.snapPoint).toEqual({
      x: 100,
      y: 100,
      kind: "corner",
    });

    move(result, 400, 400);
    up(result, 400, 400);

    expect(harness.elementsRef.current[1]).toMatchObject({ x1: 100, y1: 100 });
  });

  it("holds shift to keep the start where it was pressed", () => {
    const harness = makeHarness([box("target", { x: 100, y: 100 })], {
      tool: "Line",
    });
    const { result } = setup(harness);

    drag(
      result,
      { x: 105, y: 103 },
      { x: 400, y: 400 },
      { shiftKey: true },
    );

    expect(harness.elementsRef.current[1]).toMatchObject({ x1: 105, y1: 103 });
  });

  it("binds an arrow dropped near a shape, both ways round", () => {
    /*
     * The binding is what makes the arrow follow the shape afterwards, and it has
     * to be recorded on both: the arrow remembers what it points at, and the shape
     * remembers what points at it, or moving the shape leaves the arrow behind.
     */
    const harness = makeHarness([box("target", { x: 300, y: 0 })], {
      tool: "Arrow",
    });
    const { result } = setup(harness);

    // 15px clear of the edge: outside the point-snap radius, inside the binding gap.
    drag(result, { x: 100, y: 50 }, { x: 285, y: 50 });

    const drawn = harness.elementsRef.current[1] as LinearShape;
    expect(drawn.endBinding?.elementId).toBe("target");
    expect(harness.find("target").boundElements).toEqual([
      { id: drawn.id, type: "arrow" },
    ]);
  });

  it("binds the start to the shape it was drawn out of", () => {
    /*
     * Arrows are usually drawn *from* one shape *to* another, so the press has to
     * bind too — an arrow bound only at its head comes away from its source as
     * soon as the source moves. Note what that costs: from here on the binding
     * owns the start, and `x1/y1` are wherever the route puts them rather than
     * where the pointer went down.
     */
    const harness = makeHarness([box("source", { x: 100, y: 100 })], {
      tool: "Arrow",
    });
    const { result } = setup(harness);

    drag(result, { x: 105, y: 103 }, { x: 400, y: 400 });

    const drawn = harness.elementsRef.current[1] as LinearShape;
    expect(drawn.startBinding?.elementId).toBe("source");
    expect(harness.find("source").boundElements).toEqual([
      { id: drawn.id, type: "arrow" },
    ]);
    // Re-anchored just clear of the outline, on the diagonal towards the far end.
    expect(drawn.x1).toBeGreaterThan(200);
    expect(drawn.x1).toBeCloseTo(drawn.y1, 5);
  });

  it("leaves a plain line unbound, however close it lands", () => {
    // Lines are geometry, not connectors; a line that crept towards a shape as the
    // shape moved would make it impossible to draw a fixed rule anywhere near one.
    const harness = makeHarness([box("target", { x: 300, y: 0 })], {
      tool: "Line",
    });
    const { result } = setup(harness);

    drag(result, { x: 100, y: 50 }, { x: 285, y: 50 });

    const drawn = harness.elementsRef.current[1] as LinearShape;
    expect(drawn.endBinding ?? null).toBeNull();
    expect(harness.find("target").boundElements ?? null).toBeNull();
  });

  it("highlights the shape the end is hovering", () => {
    const harness = makeHarness([box("target", { x: 300, y: 0 })], {
      tool: "Arrow",
    });
    const { result } = setup(harness);

    down(result, 100, 50);
    move(result, 285, 50);
    expect(result.current.visuals.bindingHighlightId).toBe("target");

    move(result, 100, 400);
    expect(result.current.visuals.bindingHighlightId).toBeNull();
  });
});

/**
 * The text tool only decides *what* the press means and hands it to `Canvas`,
 * which owns the overlay; `useTextEditor` is tested next door.
 */
describe("the text tool", () => {
  it("asks for free text where the canvas was pressed", () => {
    const harness = makeHarness([], { tool: "Text" });
    const { result } = setup(harness);

    down(result, 40, 60);

    expect(harness.onCreateText).toHaveBeenCalledWith({ x: 40, y: 60 }, null);
    // Back to Select, so the next press moves the text just typed.
    expect(harness.tools).toEqual(["Select"]);
  });

  it("opens the text that was pressed rather than stacking another on it", () => {
    const harness = makeHarness([text("label")], { tool: "Text" });
    const { result } = setup(harness);

    down(result, 20, 10);

    expect(harness.onEditText).toHaveBeenCalledWith("label");
    expect(harness.onCreateText).not.toHaveBeenCalled();
  });

  it("labels the shape whose outline was pressed", () => {
    const harness = makeHarness([box("square")], { tool: "Text" });
    const { result } = setup(harness);

    down(result, 50, 0);

    expect(harness.onCreateText).toHaveBeenCalledWith({ x: 50, y: 0 }, "square");
  });

  it("labels a filled shape pressed anywhere inside it", () => {
    const harness = makeHarness([box("filled", { fill: "#ffc9c9" })], {
      tool: "Text",
    });
    const { result } = setup(harness);

    down(result, 50, 50);

    expect(harness.onCreateText).toHaveBeenCalledWith({ x: 50, y: 50 }, "filled");
  });

  it("makes free text inside an unfilled shape, which is empty space", () => {
    /*
     * A hollow shape is only its outline as far as the pointer is concerned — the
     * same rule that lets you press through it to reach what is behind. Double
     * -clicking the shape is the way to label it from the inside.
     */
    const harness = makeHarness([box("square")], { tool: "Text" });
    const { result } = setup(harness);

    down(result, 50, 50);

    expect(harness.onCreateText).toHaveBeenCalledWith({ x: 50, y: 50 }, null);
  });

  it("keeps the text tool when the tool is locked", () => {
    const harness = makeHarness([], { tool: "Text", toolLocked: true });
    const { result } = setup(harness);

    down(result, 40, 60);

    expect(harness.tools).toEqual([]);
  });
});

describe("double-click", () => {
  it("edits the text under the pointer", () => {
    const harness = makeHarness([text("label")]);
    const { result } = setup(harness);

    doubleClick(result, 20, 10);

    expect(harness.onEditText).toHaveBeenCalledWith("label");
  });

  it("labels a shape from anywhere inside it, filled or not", () => {
    // Unlike the text tool's press, this looks *through* the shape's fill: a
    // double-click inside a hollow rectangle is unambiguously aimed at it.
    const harness = makeHarness([box("square")]);
    const { result } = setup(harness);

    doubleClick(result, 50, 50);

    expect(harness.onCreateText).toHaveBeenCalledWith({ x: 50, y: 50 }, "square");
  });

  it("makes free text on empty canvas", () => {
    const harness = makeHarness();
    const { result } = setup(harness);

    const event = doubleClick(result, 300, 200);

    expect(harness.onCreateText).toHaveBeenCalledWith({ x: 300, y: 200 }, null);
    // Otherwise the browser's own double-click selects the page around the canvas.
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("does nothing on something that cannot hold a label", () => {
    // A line has no inside to write in, and free text dropped on top of it would
    // appear to belong to it while moving separately.
    const harness = makeHarness([line("rule")]);
    const { result } = setup(harness);

    doubleClick(result, 100, 100);

    expect(harness.onEditText).not.toHaveBeenCalled();
    expect(harness.onCreateText).not.toHaveBeenCalled();
  });
});

/**
 * The eraser marks as it goes and deletes once, on release. The marking is what
 * makes it usable — you can see what is about to go and back out with alt — and
 * the single commit is what makes one sweep one undo step.
 */
describe("the eraser", () => {
  it("marks what it touches and deletes on release", () => {
    const harness = makeHarness([box("a")], { tool: "Eraser" });
    const { result } = setup(harness);

    down(result, 50, 0);
    expect([...result.current.visuals.erasingIds]).toEqual(["a"]);
    // Still there: the sweep is not over, and nothing is broadcast yet.
    expect(harness.has("a")).toBe(true);
    expect(harness.applied).toEqual([]);

    up(result, 50, 0);

    expect(harness.has("a")).toBe(false);
    expect(harness.lastApplied.options).toEqual({
      deletedIds: ["a"],
      broadcast: "elements",
    });
    expect(harness.commits).toBe(1);
  });

  it("catches everything the stroke crossed between moves", () => {
    // Pointer events are sparse: a quick sweep arrives as two far-apart points, and
    // testing only those would erase nothing between them.
    const harness = makeHarness([box("a"), box("b", { x: 300 })], {
      tool: "Eraser",
    });
    const { result } = setup(harness);

    drag(result, { x: 50, y: 0 }, { x: 350, y: 0 });

    expect(harness.elementsRef.current).toEqual([]);
  });

  it("passes through the middle of a hollow shape", () => {
    // Same rule as selecting one: with nothing painted inside, there is nothing
    // there to erase, and the sweep reaches whatever is behind it instead.
    const harness = makeHarness([box("a")], { tool: "Eraser" });
    const { result } = setup(harness);

    drag(result, { x: 40, y: 50 }, { x: 60, y: 50 });

    expect(harness.has("a")).toBe(true);
    expect(harness.applied).toEqual([]);
  });

  it("puts back what alt is dragged over", () => {
    // The undo of an eraser stroke you are still in the middle of.
    const harness = makeHarness([box("a")], { tool: "Eraser" });
    const { result } = setup(harness);

    down(result, 50, 0);
    move(result, 51, 0, { altKey: true });
    expect([...result.current.visuals.erasingIds]).toEqual([]);

    up(result, 51, 0);

    expect(harness.has("a")).toBe(true);
    expect(harness.applied).toEqual([]);
  });

  it("passes harmlessly over what alt finds unmarked", () => {
    // One sweep back over a mixed stretch: `a` was marked and comes back, `b`
    // never was. Treating the second as a change would redraw the feedback on
    // every alt move, and treating it as an erase would delete it outright.
    const harness = makeHarness([box("a"), box("b", { x: 200 })], {
      tool: "Eraser",
    });
    const { result } = setup(harness);

    down(result, 50, 0);
    expect([...result.current.visuals.erasingIds]).toEqual(["a"]);

    move(result, 250, 0, { altKey: true });
    expect([...result.current.visuals.erasingIds]).toEqual([]);

    up(result, 250, 0);

    expect(harness.has("a")).toBe(true);
    expect(harness.has("b")).toBe(true);
    expect(harness.applied).toEqual([]);
  });

  it("drops what it erased from the selection", () => {
    // A selection holding a deleted id keeps drawing handles around nothing, and
    // the next drag or delete works on an element that is no longer in the scene.
    const harness = makeHarness([box("a"), box("b", { x: 300 })], {
      tool: "Eraser",
      selectedIds: ["a", "b"],
    });
    const { result } = setup(harness);

    drag(result, { x: 50, y: 0 }, { x: 50, y: 0 });

    expect(harness.selectedIds).toEqual(["b"]);
  });

  it("keeps the trail it draws bounded", () => {
    // The trail is redrawn every frame and is only ever a few pixels of feedback;
    // a long sweep must not turn it into an ever-growing polyline.
    const harness = makeHarness([], { tool: "Eraser" });
    const { result } = setup(harness);

    down(result, 0, 500);
    for (let i = 1; i <= 70; i += 1) {
      move(result, i * 2, 500);
    }

    expect(result.current.visuals.eraserTrail).toHaveLength(64);
  });
});

describe("selecting", () => {
  it("takes the shape under the pointer, hollow or not", () => {
    // Selection is the one thing that does reach inside an unfilled shape: you
    // have to be able to grab a rectangle by its middle to move it.
    const harness = makeHarness([box("a")]);
    const { result } = setup(harness);

    down(result, 50, 50);

    expect(harness.selectedIds).toEqual(["a"]);
  });

  it("takes the topmost of two shapes under the pointer", () => {
    const harness = makeHarness([box("under"), box("over", { x: 20, y: 20 })]);
    const { result } = setup(harness);

    down(result, 50, 50);

    expect(harness.selectedIds).toEqual(["over"]);
  });

  it("clears the selection on a press into empty canvas", () => {
    const harness = makeHarness([box("a")], { selectedIds: ["a"] });
    const { result } = setup(harness);

    down(result, 500, 500);

    expect(harness.selectedIds).toEqual([]);
  });

  it("leaves a multi-selection alone when one of its members is pressed", () => {
    // Otherwise dragging a group by one of its shapes would silently drop the rest
    // of the selection and move only the shape that was grabbed.
    const harness = makeHarness([box("a"), box("b", { x: 300 })], {
      selectedIds: ["a", "b"],
    });
    const { result } = setup(harness);

    down(result, 50, 50);

    expect(harness.selectedIds).toEqual(["a", "b"]);
  });

  it("shift adds a shape, and shift again takes it out", () => {
    const harness = makeHarness([box("a"), box("b", { x: 300 })], {
      selectedIds: ["a"],
    });
    const { result } = setup(harness);

    down(result, 350, 50, { shiftKey: true });
    up(result, 350, 50, { shiftKey: true });
    expect(harness.selectedIds).toEqual(["a", "b"]);

    down(result, 350, 50, { shiftKey: true });
    up(result, 350, 50, { shiftKey: true });
    expect(harness.selectedIds).toEqual(["a"]);
  });
});

describe("the marquee", () => {
  it("selects what it covers while it is drawn, and disappears on release", () => {
    const harness = makeHarness([box("a"), box("b", { x: 300 })]);
    const { result } = setup(harness);

    down(result, 200, 200);
    move(result, -10, -10);

    // Drawn backwards, so the rectangle has to be normalised to have a size at all.
    expect(result.current.visuals.marquee).toEqual({
      x: -10,
      y: -10,
      width: 210,
      height: 210,
    });
    expect(harness.selectedIds).toEqual(["a"]);

    up(result, -10, -10);

    expect(result.current.visuals.marquee).toBeNull();
    expect(harness.selectedIds).toEqual(["a"]);
    // Selecting is not an edit; nothing to commit, nothing to send.
    expect(harness.applied).toEqual([]);
  });

  it("keeps what was already selected when shift is held", () => {
    const harness = makeHarness([box("a"), box("b", { x: 300 })], {
      selectedIds: ["b"],
    });
    const { result } = setup(harness);

    down(result, 200, 200, { shiftKey: true });
    move(result, -10, -10, { shiftKey: true });

    expect(harness.selectedIds).toEqual(["b", "a"]);
  });
});

describe("dragging", () => {
  it("moves the selection with the pointer and commits once, at the end", () => {
    /*
     * Every move applies with `commit: false`: a drag across the canvas is one
     * undo step, not one per pointer event. The release is the only commit — but it
     * still has to run, or the move is never in the history at all.
     */
    const harness = makeHarness([box("a")], { selectedIds: ["a"] });
    const { result } = setup(harness);

    down(result, 50, 50);
    move(result, 150, 50);

    expect(harness.find("a").x).toBe(100);
    expect(harness.lastApplied.options).toEqual({
      commit: false,
      changedIds: ["a"],
    });
    expect(harness.commits).toBe(0);

    up(result, 150, 50);

    expect(harness.commits).toBe(1);
    expect(harness.lastApplied.options).toEqual({ changedIds: ["a"] });
  });

  it("keeps following the pointer without doubling the distance", () => {
    // Every move is measured from the snapshot taken at the press, not from where
    // the shape has got to. Measuring from the current position adds each delta on
    // top of the last and the shape runs away from the pointer.
    const harness = makeHarness([box("a")], { selectedIds: ["a"] });
    const { result } = setup(harness);

    down(result, 50, 50);
    move(result, 150, 50);
    move(result, 200, 50);

    expect(harness.find("a").x).toBe(150);
    expect(harness.commits).toBe(0);
  });

  it("waits for the pointer to travel before it moves anything", () => {
    // A press is also how you select, and a mouse never holds perfectly still: a
    // click on a shape would otherwise nudge it by a pixel and record that as an edit.
    const harness = makeHarness([box("a")], { selectedIds: ["a"] });
    const { result } = setup(harness);

    down(result, 50, 50);
    move(result, 51, 50);
    expect(harness.applied).toEqual([]);

    move(result, 60, 50);
    expect(harness.find("a").x).toBe(10);
  });

  it("changes nothing at all on a click that goes nowhere", () => {
    const harness = makeHarness([box("a")], { selectedIds: ["a"] });
    const { result } = setup(harness);

    down(result, 50, 50);
    up(result, 50, 50);

    expect(harness.applied).toEqual([]);
    expect(harness.find("a").x).toBe(0);
  });

  it("lines the shape up with its neighbour, and says why", () => {
    // 3px short of touching. Without the snap, diagrams drawn by hand are 3px out
    // everywhere, and the guide is what tells you the shape moved on purpose.
    const harness = makeHarness([box("a"), box("b", { x: 300 })], {
      selectedIds: ["a"],
    });
    const { result } = setup(harness);

    down(result, 50, 50);
    move(result, 247, 50);

    expect(harness.find("a").x).toBe(200);
    expect(
      result.current.visuals.guides.map((guide) => guide.position),
    ).toContain(300);
  });

  it("holds ctrl to put it exactly where the pointer is", () => {
    const harness = makeHarness([box("a"), box("b", { x: 300 })], {
      selectedIds: ["a"],
    });
    const { result } = setup(harness);

    down(result, 50, 50);
    move(result, 247, 50, { ctrlKey: true });

    expect(harness.find("a").x).toBe(197);
    expect(result.current.visuals.guides).toEqual([]);
  });

  it("holds alt to drag a copy, leaving the original where it was", () => {
    const harness = makeHarness([box("a")], { selectedIds: ["a"] });
    const { result } = setup(harness);

    down(result, 50, 50, { altKey: true });
    move(result, 150, 50, { altKey: true });

    expect(harness.find("a").x).toBe(0);
    const copy = harness.elementsRef.current[1];
    expect(copy.id).not.toBe("a");
    expect(copy.x).toBe(100);
    // The copy is what you are now holding, so the next drag moves it too.
    expect(harness.selectedIds).toEqual([copy.id]);
  });
});

describe("resizing", () => {
  it("resizes from the handle that was grabbed, committing on release", () => {
    const harness = makeHarness([box("a")], { selectedIds: ["a"] });
    const { result } = setup(harness);

    down(result, ...atPoint(handleAt(harness, "se", ["a"])));
    move(result, 200, 150);

    expect(harness.find("a")).toMatchObject({
      x: 0,
      y: 0,
      width: 200,
      height: 150,
    });
    expect(harness.commits).toBe(0);

    up(result, 200, 150);
    expect(harness.commits).toBe(1);
  });

  it("takes the handle in preference to whatever is under it", () => {
    // The east handle of this selection sits inside the right-hand shape. A press
    // there has to resize, not pick that shape up and drag it.
    const harness = makeHarness([box("a"), box("b", { x: 300 })], {
      selectedIds: ["a", "b"],
    });
    const { result } = setup(harness);

    down(result, ...atPoint(handleAt(harness, "e", ["a", "b"])));
    move(result, 800, 50);

    // Both shapes scale, and their gap scales with them.
    expect(harness.find("a")).toMatchObject({ x: 0, width: 200 });
    expect(harness.find("b")).toMatchObject({ x: 600, width: 200 });
  });

  it("resizes a tilted shape along its own axes", () => {
    /*
     * A rotated shape is stored unrotated and drawn turned, so the pointer has to
     * be brought back into the shape's own frame before it means anything — and
     * the result shifted, because growing one side of a turned box moves its
     * centre in a direction the box itself knows nothing about. Left in world
     * coordinates, dragging any handle of a tilted shape sends it wandering.
     *
     * A quarter turn, so the local axes are the screen's, swapped: this shape's
     * own +x runs down the screen. Its se handle is therefore at the bottom left,
     * and pulling it 100px further down is what makes the shape 100 wider.
     */
    const harness = makeHarness(
      [box("a", { width: 200, height: 100, angle: Math.PI / 2 })],
      { selectedIds: ["a"] },
    );
    const { result } = setup(harness);

    expect(handleAt(harness, "se", ["a"]).x).toBeCloseTo(50);
    expect(handleAt(harness, "se", ["a"]).y).toBeCloseTo(150);

    down(result, ...atPoint(handleAt(harness, "se", ["a"])));
    move(result, 50, 250);

    const resized = harness.find("a");
    expect(resized.width).toBeCloseTo(300);
    expect(resized.height).toBeCloseTo(100);
    // Held by the far side: the stored box slides so the turned shape grows only
    // downwards, away from the handle's opposite corner.
    expect(resized.x).toBeCloseTo(-50);
    expect(resized.y).toBeCloseTo(50);
    expect(resized.angle).toBeCloseTo(Math.PI / 2);
  });

  it("leaves the elements it is not resizing alone", () => {
    // The resize walks the whole scene to put the new versions back; rebuilding
    // the ones it does not touch would send all of them to the peers as changes.
    const bystander = box("b", { x: 600 });
    const harness = makeHarness([box("a"), bystander], { selectedIds: ["a"] });
    const { result } = setup(harness);

    down(result, ...atPoint(handleAt(harness, "se", ["a"])));
    move(result, 200, 150);

    expect(harness.find("a").width).toBe(200);
    expect(harness.find("b")).toBe(bystander);
  });

  it("holds shift to keep the proportions", () => {
    const harness = makeHarness([box("a", { width: 200, height: 100 })], {
      selectedIds: ["a"],
    });
    const { result } = setup(harness);

    down(result, ...atPoint(handleAt(harness, "se", ["a"])));
    move(result, 400, 110, { shiftKey: true });

    // The pointer went sideways, so the width leads and the height follows it.
    expect(harness.find("a")).toMatchObject({ width: 400, height: 200 });
  });

  it("holds alt to resize about the centre", () => {
    const harness = makeHarness([box("a")], { selectedIds: ["a"] });
    const { result } = setup(harness);

    down(result, ...atPoint(handleAt(harness, "se", ["a"])));
    move(result, 200, 150, { altKey: true });

    expect(harness.find("a")).toMatchObject({
      x: -100,
      y: -50,
      width: 300,
      height: 200,
    });
  });

  it("shows which handle is being worked, so the cursor matches it", () => {
    const harness = makeHarness([box("a")], { selectedIds: ["a"] });
    const { result } = setup(harness);

    down(result, ...atPoint(handleAt(harness, "se", ["a"])));
    move(result, 200, 150);

    expect(result.current.visuals.activeHandle).toBe("se");
    expect(result.current.cursor).toBe("nwse-resize");
  });
});

describe("rotating", () => {
  it("turns the shape about its centre, following the pointer", () => {
    /*
     * The angle is measured from where the handle was grabbed, not from straight
     * up, so the shape does not jump a quarter turn the moment it is touched.
     */
    const harness = makeHarness([box("a")], { selectedIds: ["a"] });
    const { result } = setup(harness);

    down(result, ...atPoint(handleAt(harness, "rotate", ["a"])));
    // A quarter turn clockwise: from above the shape round to its right-hand side.
    move(result, 122, 50);

    expect(harness.find("a").angle).toBeCloseTo(Math.PI / 2);
    // Turning about the centre leaves the box where it is.
    expect(harness.find("a")).toMatchObject({ x: 0, y: 0 });
    expect(result.current.visuals.activeHandle).toBe("rotate");
    expect(result.current.cursor).toBe("grabbing");
  });

  it("holds shift to turn in fifteen-degree steps", () => {
    const harness = makeHarness([box("a")], { selectedIds: ["a"] });
    const { result } = setup(harness);

    down(result, ...atPoint(handleAt(harness, "rotate", ["a"])));

    // 95.7 degrees round, which is what a hand aiming at 90 actually produces.
    move(result, 100, 55);
    expect(harness.find("a").angle).toBeCloseTo(1.6704);

    move(result, 100, 55, { shiftKey: true });
    expect(harness.find("a").angle).toBeCloseTo(Math.PI / 2);
  });

  it("leaves the elements it is not turning alone", () => {
    // As with a resize: the turn walks the whole scene, and the elements outside
    // the selection have to come back as the very same objects.
    const bystander = box("b", { x: 600 });
    const harness = makeHarness([box("a"), bystander], { selectedIds: ["a"] });
    const { result } = setup(harness);

    down(result, ...atPoint(handleAt(harness, "rotate", ["a"])));
    move(result, 122, 50);

    expect(harness.find("a").angle).toBeCloseTo(Math.PI / 2);
    expect(harness.find("b")).toBe(bystander);
  });

  it("commits the turn on release", () => {
    const harness = makeHarness([box("a")], { selectedIds: ["a"] });
    const { result } = setup(harness);

    down(result, ...atPoint(handleAt(harness, "rotate", ["a"])));
    move(result, 122, 50);
    expect(harness.commits).toBe(0);

    up(result, 122, 50);

    expect(harness.commits).toBe(1);
    expect(harness.lastApplied.options).toEqual({ changedIds: ["a"] });
  });
});

describe("an arrow's ends", () => {
  const linear = (harness: Harness, id: string) =>
    harness.find(id) as LinearShape;

  it("moves the end that was grabbed and leaves the other alone", () => {
    const harness = makeHarness([arrow("a")], { selectedIds: ["a"] });
    const { result } = setup(harness);

    down(result, ...atPoint(handleAt(harness, "end", ["a"])));
    move(result, 300, 200);
    up(result, 300, 200);

    expect(linear(harness, "a")).toMatchObject({
      x1: 0,
      y1: 100,
      x2: 300,
      y2: 200,
    });
    expect(harness.commits).toBe(1);
  });

  it("binds to the shape the end is dropped on", () => {
    /*
     * Dropping an end on a shape is how a diagram is wired up after the fact, and
     * the binding has to be written on release: it is what survives the shape
     * moving afterwards.
     */
    const harness = makeHarness([arrow("a"), box("t", { x: 300 })], {
      selectedIds: ["a"],
    });
    const { result } = setup(harness);

    down(result, ...atPoint(handleAt(harness, "end", ["a"])));
    move(result, 285, 100);
    // The highlight is the promise that letting go will attach it.
    expect(result.current.visuals.bindingHighlightId).toBe("t");

    up(result, 285, 100);

    expect(linear(harness, "a").endBinding?.elementId).toBe("t");
    expect(harness.find("t").boundElements).toEqual([
      { id: "a", type: "arrow" },
    ]);
  });

  it("moves the start that was grabbed and leaves the other alone", () => {
    // The tail is dragged as often as the head, and the two are not symmetrical in
    // the code: each writes its own pair of coordinates and its own binding.
    const harness = makeHarness([arrow("a")], { selectedIds: ["a"] });
    const { result } = setup(harness);

    down(result, ...atPoint(handleAt(harness, "start", ["a"])));
    move(result, 40, 300);
    up(result, 40, 300);

    expect(linear(harness, "a")).toMatchObject({
      x1: 40,
      y1: 300,
      x2: 200,
      y2: 100,
    });
    expect(harness.commits).toBe(1);
  });

  it("binds the start to the shape it is dropped on", () => {
    const harness = makeHarness([arrow("a"), box("t", { x: 300 })], {
      selectedIds: ["a"],
    });
    const { result } = setup(harness);

    down(result, ...atPoint(handleAt(harness, "start", ["a"])));
    move(result, 285, 100);
    expect(result.current.visuals.bindingHighlightId).toBe("t");

    up(result, 285, 100);

    expect(linear(harness, "a").startBinding?.elementId).toBe("t");
    expect(harness.find("t").boundElements).toEqual([
      { id: "a", type: "arrow" },
    ]);
  });

  it("leaves a plain line's end exactly where it was dropped", () => {
    const harness = makeHarness([line("l"), box("t", { x: 300 })], {
      selectedIds: ["l"],
    });
    const { result } = setup(harness);

    down(result, ...atPoint(handleAt(harness, "end", ["l"])));
    move(result, 285, 100);
    up(result, 285, 100);

    expect(linear(harness, "l")).toMatchObject({ x2: 285, y2: 100 });
    expect(harness.find("t").boundElements ?? null).toBeNull();
  });

  it("holds shift to keep the end on a fifteen-degree line", () => {
    const harness = makeHarness([arrow("a")], { selectedIds: ["a"] });
    const { result } = setup(harness);

    down(result, ...atPoint(handleAt(harness, "end", ["a"])));
    move(result, 200, 190, { shiftKey: true });

    // 24 degrees from the other end, rounded to 30.
    const { x1, y1, x2, y2 } = linear(harness, "a");
    expect(Math.atan2(y2 - y1, x2 - x1)).toBeCloseTo(Math.PI / 6);
  });
});

/**
 * Bends. The phantom handle in the middle of a segment is how one is made, the
 * handle on the bend itself is how it is moved, and both have to be able to undo
 * cleanly — a bend is only worth having if it is where the pointer left it.
 */
describe("waypoints", () => {
  const midPoints = (harness: Harness, id: string) =>
    (harness.find(id) as LinearShape).midPoints;

  it("pulls a new bend out of a segment", () => {
    const harness = makeHarness([arrow("a")], { selectedIds: ["a"] });
    const { result } = setup(harness);

    down(result, ...atPoint(handleAt(harness, "add-0", ["a"])));
    move(result, 100, 200);
    up(result, 100, 200);

    expect(midPoints(harness, "a")).toEqual([100, 200]);
    // Inserting and dragging are both provisional; the release is the undo step.
    expect(harness.commits).toBe(1);
  });

  it("drops a bend that was left on the straight line", () => {
    // A bend with nothing to show for it still puts a handle on the arrow and
    // still has to be dragged out of the way; better not to keep it.
    const harness = makeHarness([arrow("a")], { selectedIds: ["a"] });
    const { result } = setup(harness);

    down(result, ...atPoint(handleAt(harness, "add-0", ["a"])));
    move(result, 100, 101);
    up(result, 100, 101);

    expect(midPoints(harness, "a")).toEqual([]);
  });

  it("moves an existing bend", () => {
    const harness = makeHarness([arrow("a", { midPoints: [100, 200] })], {
      selectedIds: ["a"],
    });
    const { result } = setup(harness);

    down(result, ...atPoint(handleAt(harness, "mid-0", ["a"])));
    move(result, 140, 260);
    up(result, 140, 260);

    expect(midPoints(harness, "a")).toEqual([140, 260]);
  });

  it("alt-clicks a bend away without moving anything", () => {
    const harness = makeHarness([arrow("a", { midPoints: [100, 200] })], {
      selectedIds: ["a"],
    });
    const { result } = setup(harness);

    down(result, ...atPoint(handleAt(harness, "mid-0", ["a"])), {
      altKey: true,
    });

    expect(midPoints(harness, "a")).toEqual([]);
    expect(harness.commits).toBe(1);
  });

  it("leaves the rest of the scene alone as bends come and go", () => {
    // All three operations map over the whole scene to find the arrow, and each
    // one has to hand back the elements it walked past unchanged — an arrow being
    // bent should not send every other element to the peers as a change.
    const bystander = box("b", { x: 400 });
    const harness = makeHarness([arrow("a"), bystander], {
      selectedIds: ["a"],
    });
    const { result } = setup(harness);

    down(result, ...atPoint(handleAt(harness, "add-0", ["a"])));
    move(result, 100, 200);
    up(result, 100, 200);
    expect(midPoints(harness, "a")).toEqual([100, 200]);
    expect(harness.find("b")).toBe(bystander);

    down(result, ...atPoint(handleAt(harness, "mid-0", ["a"])));
    move(result, 140, 260);
    up(result, 140, 260);
    expect(midPoints(harness, "a")).toEqual([140, 260]);
    expect(harness.find("b")).toBe(bystander);

    down(result, ...atPoint(handleAt(harness, "mid-0", ["a"])), {
      altKey: true,
    });
    expect(midPoints(harness, "a")).toEqual([]);
    expect(harness.find("b")).toBe(bystander);
  });
});

/**
 * Escape, or the browser taking the pointer away (a system gesture, a lost
 * touch). Either way the gesture has to come apart cleanly: whatever it had
 * already moved goes back, and because none of that was ever committed, the
 * revert must not be committed either — an undo step for a cancelled gesture is
 * an undo step the user never made.
 */
describe("cancelling", () => {
  it("puts back what a drag had moved, without an undo step", () => {
    const bystander = box("b", { x: 600 });
    const harness = makeHarness([box("a"), bystander], { selectedIds: ["a"] });
    const { result } = setup(harness);

    down(result, 50, 50);
    move(result, 150, 50);
    expect(harness.find("a").x).toBe(100);

    act(() => result.current.cancel());

    expect(harness.find("a").x).toBe(0);
    // The revert walks the whole scene; what it did not move it must not rebuild.
    expect(harness.find("b")).toBe(bystander);
    expect(harness.lastApplied.options).toEqual({
      commit: false,
      broadcast: "elements",
    });
    expect(harness.commits).toBe(0);
  });

  it("throws away a shape that was being drawn", () => {
    const harness = makeHarness([], { tool: "Square" });
    const { result } = setup(harness);

    down(result, 10, 10);
    move(result, 60, 40);

    act(() => result.current.cancel());

    expect(result.current.pendingElement).toBeNull();
    expect(harness.elementsRef.current).toEqual([]);
    expect(harness.applied).toEqual([]);
  });

  it("clears a marquee without touching the scene", () => {
    const harness = makeHarness([box("a")]);
    const { result } = setup(harness);

    down(result, 500, 500);
    move(result, 400, 400);

    act(() => result.current.cancel());

    expect(result.current.visuals.marquee).toBeNull();
    expect(harness.applied).toEqual([]);
  });

  it("gives up the capture when the browser takes the pointer away", () => {
    const harness = makeHarness([box("a")], { selectedIds: ["a"] });
    const { result } = setup(harness);

    down(result, 50, 50);
    move(result, 150, 50);
    cancelPointer(result);

    expect(harness.releases).toEqual([1]);
    expect(harness.find("a").x).toBe(0);
  });

  it("leaves a finished gesture alone", () => {
    // Escape after a drag has been released must not undo it: by then the move is
    // committed, and the snapshot it would restore is a scene two steps old.
    const harness = makeHarness([box("a")], { selectedIds: ["a"] });
    const { result } = setup(harness);

    drag(result, { x: 50, y: 50 }, { x: 150, y: 50 });
    const applies = harness.applied.length;

    act(() => result.current.cancel());

    expect(harness.find("a").x).toBe(100);
    expect(harness.applied).toHaveLength(applies);
  });
});

/**
 * The cursor is the only thing that tells you what a press is about to do before
 * you make it, which is why it is worth testing at all.
 *
 * One thing it does *not* do: `cursor` is memoised on the hover cursor and the
 * active handle, so the arms for `panning` and `dragging` cannot be reached —
 * neither dependency changes during either gesture. Resizing and rotating do
 * change the active handle, which is why those two are asserted where they
 * happen. The visible effect is that a pan shows "grab" rather than "grabbing";
 * a drag shows "move" either way, which is why it went unnoticed.
 */
describe("the hover cursor", () => {
  it("offers to move a shape, and nothing over empty canvas", () => {
    const harness = makeHarness([box("a")]);
    const { result } = setup(harness);

    move(result, 50, 50);
    expect(result.current.cursor).toBe("move");

    move(result, 500, 500);
    expect(result.current.cursor).toBe("default");
  });

  it("names the handle under the pointer", () => {
    // Each handle has to advertise the axis it resizes before the press, not after.
    const harness = makeHarness([box("a")], { selectedIds: ["a"] });
    const { result } = setup(harness);

    move(result, ...atPoint(handleAt(harness, "se", ["a"])));
    expect(result.current.cursor).toBe("nwse-resize");

    move(result, ...atPoint(handleAt(harness, "n", ["a"])));
    expect(result.current.cursor).toBe("ns-resize");

    move(result, ...atPoint(handleAt(harness, "rotate", ["a"])));
    expect(result.current.cursor).toBe("grab");
  });

  it("crosshairs for a tool that draws, and for the eraser", () => {
    const harness = makeHarness([box("a")], { tool: "Square" });
    const { result } = setup(harness);

    move(result, 50, 50);
    expect(result.current.cursor).toBe("crosshair");

    act(() => result.current.chooseTool("Eraser"));
    move(result, 50, 50);
    expect(result.current.cursor).toBe("crosshair");

    // Back to Select and the shape under the pointer matters again.
    act(() => result.current.chooseTool("Select"));
    move(result, 50, 50);
    expect(result.current.cursor).toBe("move");
  });

  it("offers to pan whenever panning is what a press would do", () => {
    const harness = makeHarness([box("a")]);
    const { result } = setup(harness);

    harness.spacePressedRef.current = true;
    move(result, 50, 50);
    expect(result.current.cursor).toBe("grab");

    harness.spacePressedRef.current = false;
    act(() => result.current.chooseTool("Pan"));
    move(result, 50, 50);
    expect(result.current.cursor).toBe("grab");
  });
});

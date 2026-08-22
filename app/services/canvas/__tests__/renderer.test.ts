import { describe, expect, it } from "vitest";
import rough from "roughjs";
import { createCanvas } from "canvas";

import { createElement, mutateElement } from "../elements";
import {
  exportSceneToDataURL,
  renderInteractiveScene,
  renderStaticScene,
} from "../renderer";
import { getSelectionBounds } from "../transform";
import { refreshLinearElement } from "../linearElement";
import type { LinearShape, Shape, Viewport } from "../../../types/shapes";

const VIEWPORT: Viewport = { zoom: 1, scroll: { x: 0, y: 0 } };

const surface = (width = 400, height = 300) => {
  const canvas = createCanvas(width, height) as unknown as HTMLCanvasElement;
  return { canvas, roughCanvas: rough.canvas(canvas) };
};

/** One element of every kind, so nothing is silently skipped. */
const everyShape = (): Shape[] => [
  createElement("Square", { x: 10, y: 10, width: 80, height: 40, seed: 1 })!,
  createElement("Square", {
    x: 110,
    y: 10,
    width: 80,
    height: 40,
    fill: "#ffec99",
    seed: 2,
  })!,
  createElement("Circle", { x: 10, y: 70, width: 80, height: 60, seed: 3 })!,
  createElement("Diamond", { x: 110, y: 70, width: 80, height: 60, seed: 4 })!,
  createElement("Triangle", { x: 300, y: 150, width: 80, height: 60, seed: 9 })!,
  createElement("Line", { x1: 10, y1: 150, x2: 90, y2: 190, seed: 5 })!,
  createElement("Arrow", { x1: 110, y1: 150, x2: 190, y2: 190, seed: 6 })!,
  createElement("Freehand", {
    points: [220, 20, 240, 40, 260, 20, 280, 60],
    seed: 7,
  })!,
  createElement("Text", {
    x: 220,
    y: 100,
    text: "hello\nworld",
    seed: 8,
  })!,
];

const pixels = (canvas: HTMLCanvasElement): Buffer =>
  (canvas as unknown as { toBuffer: (type: string) => Buffer }).toBuffer(
    "image/png",
  );

const nonBlankPixelCount = (canvas: HTMLCanvasElement): number => {
  const context = canvas.getContext("2d")!;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let count = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 0) {
      count += 1;
    }
  }
  return count;
};

describe("renderStaticScene", () => {
  it("draws every element kind without throwing", () => {
    const { canvas, roughCanvas } = surface();

    renderStaticScene({
      canvas,
      roughCanvas,
      elements: everyShape(),
      viewport: VIEWPORT,
      devicePixelRatio: 1,
    });

    expect(nonBlankPixelCount(canvas)).toBeGreaterThan(500);
  });

  it("is deterministic: the same scene renders identically twice", () => {
    // This is the fix for shapes re-randomising their sketch on every redraw.
    const elements = everyShape();

    const first = surface();
    renderStaticScene({
      canvas: first.canvas,
      roughCanvas: first.roughCanvas,
      elements,
      viewport: VIEWPORT,
      devicePixelRatio: 1,
    });

    const second = surface();
    renderStaticScene({
      canvas: second.canvas,
      roughCanvas: second.roughCanvas,
      elements,
      viewport: VIEWPORT,
      devicePixelRatio: 1,
    });

    expect(pixels(first.canvas).equals(pixels(second.canvas))).toBe(true);
  });

  it("renders two shapes with different seeds differently", () => {
    const draw = (seed: number) => {
      const { canvas, roughCanvas } = surface(120, 80);
      renderStaticScene({
        canvas,
        roughCanvas,
        elements: [
          createElement("Square", {
            x: 10,
            y: 10,
            width: 100,
            height: 60,
            seed,
            roughness: 2,
          })!,
        ],
        viewport: VIEWPORT,
        devicePixelRatio: 1,
      });
      return pixels(canvas);
    };

    expect(draw(1).equals(draw(999_999))).toBe(false);
  });

  it("survives a rebuild after a mutation", () => {
    const { canvas, roughCanvas } = surface();
    const element = createElement("Square", {
      x: 10,
      y: 10,
      width: 50,
      height: 50,
      seed: 42,
    })!;

    const render = (shape: Shape) =>
      renderStaticScene({
        canvas,
        roughCanvas,
        elements: [shape],
        viewport: VIEWPORT,
        devicePixelRatio: 1,
      });

    render(element);
    const before = pixels(canvas);

    render(mutateElement(element, { x: 200 }));
    const after = pixels(canvas);

    expect(before.equals(after)).toBe(false);
  });

  it("honours zoom and scroll", () => {
    const elements = [
      createElement("Square", { x: 10, y: 10, width: 40, height: 40, seed: 1 })!,
    ];

    const drawAt = (viewport: Viewport) => {
      const { canvas, roughCanvas } = surface();
      renderStaticScene({
        canvas,
        roughCanvas,
        elements,
        viewport,
        devicePixelRatio: 1,
      });
      return nonBlankPixelCount(canvas);
    };

    const normal = drawAt(VIEWPORT);
    const zoomed = drawAt({ zoom: 3, scroll: { x: 0, y: 0 } });
    // A bigger shape covers more pixels.
    expect(zoomed).toBeGreaterThan(normal);

    // Scrolled far away, the shape is culled entirely.
    expect(drawAt({ zoom: 1, scroll: { x: -5000, y: -5000 } })).toBe(0);
  });

  it("fades elements the eraser is hovering rather than removing them", () => {
    const elements = [
      createElement("Square", {
        x: 10,
        y: 10,
        width: 100,
        height: 60,
        seed: 5,
      })!,
    ];

    const draw = (erasingIds?: Set<string>) => {
      const { canvas, roughCanvas } = surface();
      renderStaticScene({
        canvas,
        roughCanvas,
        elements,
        viewport: VIEWPORT,
        devicePixelRatio: 1,
        erasingIds,
      });
      return pixels(canvas);
    };

    const plain = draw();
    const fading = draw(new Set([elements[0].id]));

    expect(plain.equals(fading)).toBe(false);
    // Still drawn — just dimmer.
    expect(fading.length).toBeGreaterThan(0);
  });

  it("draws the in-flight element on top of the scene", () => {
    const { canvas, roughCanvas } = surface();
    const pending = createElement("Square", {
      x: 200,
      y: 200,
      width: 50,
      height: 50,
      seed: 9,
    })!;

    renderStaticScene({
      canvas,
      roughCanvas,
      elements: [],
      viewport: VIEWPORT,
      devicePixelRatio: 1,
      pendingElement: pending,
    });

    expect(nonBlankPixelCount(canvas)).toBeGreaterThan(50);
  });

  it("still paints a line after its ends have been dragged out", () => {
    // The regression this guards: a line created degenerate at pointer-down and
    // then dragged out rendered as nothing, because its derived path was never
    // re-resolved. Building one with its final coordinates would not catch it.
    const created = createElement("Line", {
      x1: 40,
      y1: 40,
      x2: 40,
      y2: 40,
      seed: 17,
    }) as LinearShape;

    const dragged = refreshLinearElement(
      { ...created, x2: 340, y2: 240, version: created.version + 1 },
      [],
    );

    const { canvas, roughCanvas } = surface();
    renderStaticScene({
      canvas,
      roughCanvas,
      elements: [dragged],
      viewport: VIEWPORT,
      devicePixelRatio: 1,
    });

    expect(nonBlankPixelCount(canvas)).toBeGreaterThan(200);
  });

  it("draws every edge style, including a bent route", () => {
    // Each style takes a different rough.js path (linearPath / curve / path with
    // rounded corners), so each needs exercising.
    for (const edgeStyle of ["straight", "curved", "elbow"] as const) {
      const { canvas, roughCanvas } = surface();

      const connector = createElement("Arrow", {
        x1: 20,
        y1: 20,
        x2: 320,
        y2: 220,
        midPoints: [160, 20, 160, 220],
        edgeStyle,
        seed: 21,
      })!;

      renderStaticScene({
        canvas,
        roughCanvas,
        elements: [
          refreshLinearElement(connector as LinearShape, []),
        ],
        viewport: VIEWPORT,
        devicePixelRatio: 1,
      });

      expect(nonBlankPixelCount(canvas)).toBeGreaterThan(200);
    }
  });

  it("renders a bent connector differently from a straight one", () => {
    const draw = (midPoints: number[]) => {
      const { canvas, roughCanvas } = surface();
      const connector = refreshLinearElement(
        createElement("Arrow", {
          x1: 20,
          y1: 120,
          x2: 320,
          y2: 120,
          midPoints,
          edgeStyle: "straight",
          seed: 33,
        }) as LinearShape,
        [],
      );

      renderStaticScene({
        canvas,
        roughCanvas,
        elements: [connector],
        viewport: VIEWPORT,
        devicePixelRatio: 1,
      });

      return pixels(canvas);
    };

    expect(draw([]).equals(draw([170, 30]))).toBe(false);
  });
});

describe("renderInteractiveScene", () => {
  it("draws selection, handles, marquee, guides and the eraser trail", () => {
    const { canvas } = surface();
    const elements = everyShape().slice(0, 2);

    renderInteractiveScene({
      canvas,
      viewport: VIEWPORT,
      devicePixelRatio: 1,
      selectedElements: elements,
      selectionBounds: getSelectionBounds(elements),
      marquee: { x: 5, y: 5, width: 100, height: 80 },
      bindingHighlightElement: elements[0],
      alignmentGuides: [
        { orientation: "vertical", position: 50, from: 0, to: 300 },
        { orientation: "horizontal", position: 60, from: 0, to: 400 },
      ],
      eraserTrail: [
        { x: 0, y: 0 },
        { x: 40, y: 40 },
        { x: 80, y: 20 },
      ],
      activeHandle: "se",
      isTransforming: true,
      showHandles: true,
    });

    expect(nonBlankPixelCount(canvas)).toBeGreaterThan(200);
  });

  it("clears when there is nothing to show", () => {
    const { canvas } = surface();

    renderInteractiveScene({
      canvas,
      viewport: VIEWPORT,
      devicePixelRatio: 1,
      selectedElements: [],
      selectionBounds: null,
    });

    expect(nonBlankPixelCount(canvas)).toBe(0);
  });

  it("draws round endpoint handles for a single linear element", () => {
    const { canvas } = surface();
    const arrow = createElement("Arrow", {
      x1: 50,
      y1: 50,
      x2: 200,
      y2: 150,
      seed: 3,
    })!;

    renderInteractiveScene({
      canvas,
      viewport: VIEWPORT,
      devicePixelRatio: 1,
      selectedElements: [arrow],
      selectionBounds: getSelectionBounds([arrow]),
    });

    expect(nonBlankPixelCount(canvas)).toBeGreaterThan(50);
  });
});

describe("exportSceneToDataURL", () => {
  it("returns a PNG data URL cropped to the drawing", () => {
    const dataURL = exportSceneToDataURL(everyShape());
    expect(dataURL).toMatch(/^data:image\/png;base64,/);
  });

  it("returns null for an empty scene", () => {
    expect(exportSceneToDataURL([])).toBeNull();
  });

  it("ignores deleted elements", () => {
    const deleted = createElement("Square", {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      isDeleted: true,
    })!;
    expect(exportSceneToDataURL([deleted])).toBeNull();
  });

  it("does not carry over a peer's in-progress styling", () => {
    const element = createElement("Square", {
      x: 0,
      y: 0,
      width: 60,
      height: 60,
      seed: 11,
    })!;

    const plain = exportSceneToDataURL([element]);
    const inProgress = exportSceneToDataURL([
      { ...element, isInProgress: true },
    ]);

    expect(inProgress).toEqual(plain);
  });
});

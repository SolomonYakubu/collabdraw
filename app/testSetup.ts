/**
 * Test environment shims.
 *
 * node-canvas gives us a real 2D context, but not `Path2D` or a DOM, both of
 * which the renderer uses. These stand-ins are only good enough to let the
 * rendering code run and produce pixels.
 *
 * Every shim is conditional, because this setup also runs for files that opt
 * into jsdom (`// @vitest-environment jsdom`). There a real `document` already
 * exists and must not be replaced by the one-method stub below.
 */
import { CanvasRenderingContext2D, createCanvas } from "canvas";

type Op = [string, number[]];

class Path2DShim {
  ops: Op[] = [];

  moveTo(...args: number[]) {
    this.ops.push(["moveTo", args]);
  }

  lineTo(...args: number[]) {
    this.ops.push(["lineTo", args]);
  }

  quadraticCurveTo(...args: number[]) {
    this.ops.push(["quadraticCurveTo", args]);
  }

  bezierCurveTo(...args: number[]) {
    this.ops.push(["bezierCurveTo", args]);
  }

  closePath() {
    this.ops.push(["closePath", []]);
  }

  replay(context: CanvasRenderingContext2D) {
    context.beginPath();
    for (const [op, args] of this.ops) {
      (context as unknown as Record<string, (...a: number[]) => void>)[op](
        ...args,
      );
    }
  }
}

const globals = globalThis as unknown as Record<string, unknown>;

if (!globals.Path2D) {
  globals.Path2D = Path2DShim;
}

if (!globals.document) {
  globals.document = {
    createElement: (tag: string) =>
      tag === "canvas" ? createCanvas(1, 1) : ({} as unknown),
  };
}

// Teach `fill(path)` to accept the shim.
const originalFill = CanvasRenderingContext2D.prototype.fill;
CanvasRenderingContext2D.prototype.fill = function patchedFill(
  this: CanvasRenderingContext2D,
  ...args: unknown[]
) {
  if (args[0] instanceof Path2DShim) {
    (args[0] as Path2DShim).replay(this);
    return (originalFill as (this: CanvasRenderingContext2D) => void).call(this);
  }
  return (
    originalFill as (this: CanvasRenderingContext2D, ...a: unknown[]) => void
  ).apply(this, args);
};

export { createCanvas };

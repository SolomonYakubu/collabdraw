import { describe, expect, it } from "vitest";

import { decideInitialScene } from "../hydration";
import type { Shape } from "../../../types/shapes";

const shape = (id: string): Shape =>
  ({ id, tool: "Square" } as unknown as Shape);

describe("decideInitialScene", () => {
  it("adopts a non-empty hydration over an empty local scene", () => {
    expect(decideInitialScene([shape("a")], [])).toBe("adopt");
  });

  it("adopts a non-empty hydration over a non-empty local scene", () => {
    expect(decideInitialScene([shape("a")], [shape("b")])).toBe("adopt");
  });

  it("adopts an empty hydration when the local scene is also empty", () => {
    expect(decideInitialScene([], [])).toBe("adopt");
  });

  it("refuses an empty hydration that would blank a DB-loaded board", () => {
    expect(decideInitialScene([], [shape("a")])).toBe("push-local");
  });
});

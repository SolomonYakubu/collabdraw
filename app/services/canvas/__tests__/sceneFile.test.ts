import { describe, expect, it } from "vitest";

import {
  parseSceneFile,
  sceneFileName,
  SCENE_FILE_TYPE,
  SCENE_FILE_VERSION,
  serializeScene,
} from "../sceneFile";
import type { Shape, Viewport } from "../../../types/shapes";

const square = (id: string): Shape =>
  ({
    id,
    tool: "Square",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  }) as unknown as Shape;

const viewport: Viewport = { zoom: 1.5, scroll: { x: 12, y: -8 } };

describe("serializeScene", () => {
  it("writes a self-describing document", () => {
    const parsed = JSON.parse(serializeScene([square("a")], viewport));
    expect(parsed.type).toBe(SCENE_FILE_TYPE);
    expect(parsed.version).toBe(SCENE_FILE_VERSION);
    expect(parsed.elements).toHaveLength(1);
    expect(parsed.viewport).toEqual(viewport);
  });
});

describe("parseSceneFile", () => {
  it("round-trips a file it wrote", () => {
    const file = parseSceneFile(serializeScene([square("a"), square("b")], viewport));
    expect(file?.elements).toHaveLength(2);
    expect(file?.viewport).toEqual(viewport);
  });

  it("returns null for text that is not JSON", () => {
    expect(parseSceneFile("nope")).toBeNull();
  });

  it("returns null for JSON that is not a CollabDraw scene", () => {
    expect(parseSceneFile(JSON.stringify({ type: "excalidraw" }))).toBeNull();
  });

  it("distinguishes an empty scene from the wrong file", () => {
    const file = parseSceneFile(serializeScene([], null));
    expect(file).not.toBeNull();
    expect(file?.elements).toEqual([]);
    expect(file?.viewport).toBeNull();
  });

  it("drops elements it cannot restore", () => {
    const file = parseSceneFile(
      JSON.stringify({
        type: SCENE_FILE_TYPE,
        elements: [square("a"), { tool: "Bogus" }, "x"],
      }),
    );
    expect(file?.elements).toHaveLength(1);
  });

  it("ignores a malformed viewport", () => {
    const file = parseSceneFile(
      JSON.stringify({
        type: SCENE_FILE_TYPE,
        elements: [],
        viewport: { zoom: 1 },
      }),
    );
    expect(file?.viewport).toBeNull();
  });
});

describe("sceneFileName", () => {
  it("dates the file and uses the scene extension", () => {
    expect(sceneFileName(new Date("2026-08-28T10:00:00Z"))).toBe(
      "collabdraw-2026-08-28.collabdraw",
    );
  });
});

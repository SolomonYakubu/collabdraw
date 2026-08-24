import { describe, expect, it } from "vitest";
import { readStringField, scanArray } from "../streamParse";
import { parseSceneItem, type SceneItem } from "../scene";
import { placeSceneItem, buildScene, sceneFrame } from "../build";
import { parseSceneSpec } from "../scene";
import type { Shape, TextShape } from "../../../types/shapes";

/**
 * Feed a buffer one character at a time, collecting objects from `key` the way
 * the client does: re-scan on each step and take only what is newly complete.
 * This is the adversarial case — every chunk boundary is exercised.
 */
const streamObjects = (full: string, key: string): unknown[] => {
  const collected: unknown[] = [];
  let seen = 0;
  let buffer = "";

  for (const char of full) {
    buffer += char;
    const scan = scanArray(buffer, key);
    for (const object of scan.objects.slice(seen)) {
      collected.push(object);
    }
    seen = scan.objects.length;
  }

  return collected;
};

describe("readStringField", () => {
  it("reads a complete enum field", () => {
    expect(readStringField('{"kind":"scene"', "kind")).toBe("scene");
    expect(readStringField('{"kind": "grid" ,', "kind")).toBe("grid");
  });

  it("returns null until the value's closing quote arrives", () => {
    expect(readStringField('{"kind":"sce', "kind")).toBeNull();
    expect(readStringField('{"kind":"', "kind")).toBeNull();
  });

  it("returns null when the field is absent", () => {
    expect(readStringField('{"title":"x"}', "kind")).toBeNull();
  });

  it("picks out the right field among several", () => {
    const buffer = '{"kind":"scene","title":"A house","placement":"replace"';
    expect(readStringField(buffer, "kind")).toBe("scene");
    expect(readStringField(buffer, "placement")).toBe("replace");
  });
});

describe("scanArray", () => {
  it("reports not started before the array opens", () => {
    const scan = scanArray('{"kind":"scene","scene":{', "items");
    expect(scan.started).toBe(false);
    expect(scan.objects).toEqual([]);
    expect(scan.closed).toBe(false);
  });

  it("emits nothing for a half-written object", () => {
    const scan = scanArray('"items":[{"shape":"rect', "items");
    expect(scan.started).toBe(true);
    expect(scan.objects).toEqual([]);
    expect(scan.closed).toBe(false);
  });

  it("emits complete objects in order and marks closure", () => {
    const scan = scanArray('"items":[{"a":1},{"a":2}]', "items");
    expect(scan.objects).toEqual([{ a: 1 }, { a: 2 }]);
    expect(scan.closed).toBe(true);
  });

  it("is not fooled by braces, brackets or quotes inside a string", () => {
    const scan = scanArray('"items":[{"text":"a } ] { \\" value"}]', "items");
    expect(scan.objects).toEqual([{ text: 'a } ] { " value' }]);
    expect(scan.closed).toBe(true);
  });

  it("handles an escaped backslash at the end of a string", () => {
    const scan = scanArray('"items":[{"text":"path\\\\"}]', "items");
    expect(scan.objects).toEqual([{ text: "path\\" }]);
  });

  it("emits each object exactly once as the buffer grows", () => {
    const full = '{"scene":{"items":[{"a":1},{"a":2},{"a":3}]}}';
    expect(streamObjects(full, "items")).toEqual([
      { a: 1 },
      { a: 2 },
      { a: 3 },
    ]);
  });

  it("emits objects whose braces and quotes split across chunks", () => {
    const full = '{"items":[{"text":"} ] {"},{"text":"\\"quoted\\""}]}';
    expect(streamObjects(full, "items")).toEqual([
      { text: "} ] {" },
      { text: '"quoted"' },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * End-to-end parity: streaming a scene builds the same thing as the
 * whole-spec build. Same validator, frame and builders — only ids differ.
 * ------------------------------------------------------------------ */

const item = (over: Partial<SceneItem>): Record<string, unknown> => ({
  shape: "rectangle",
  x: 10,
  y: 10,
  width: 20,
  height: 20,
  x2: 0,
  y2: 0,
  text: "",
  accent: "none",
  filled: false,
  rotation: 0,
  ...over,
});

/** Compare two element lists ignoring the fields that are minted per object. */
const shapeOf = (elements: readonly Shape[]) =>
  elements.map((element) => ({
    tool: element.tool,
    x: Math.round(element.x),
    y: Math.round(element.y),
    width: Math.round(element.width),
    height: Math.round(element.height),
    text: element.tool === "Text" ? (element as TextShape).text : undefined,
  }));

describe("streamed scene parity", () => {
  it("produces the same elements streamed as built whole", () => {
    const items = [
      item({ shape: "rectangle", x: 5, y: 5, width: 30, height: 20, text: "House" }),
      item({ shape: "ellipse", x: 40, y: 40, width: 15, height: 15, filled: true, accent: "blue" }),
      item({ shape: "arrow", x: 10, y: 60, x2: 50, y2: 60, text: "F" }),
      item({ shape: "text", x: 20, y: 80, height: 6, text: "A label" }),
    ];

    const envelope = JSON.stringify({
      kind: "scene",
      title: "Test",
      summary: "S",
      placement: "replace",
      scene: { items },
    });

    const frame = sceneFrame({ x: 0, y: 0 }, null);

    // Streamed: scan progressively, validate + build each object.
    const streamed: Shape[] = [];
    for (const raw of streamObjects(envelope, "items")) {
      const parsed = parseSceneItem(raw);
      if (parsed) {
        streamed.push(...placeSceneItem(parsed, frame, undefined));
      }
    }

    // Whole: the authoritative path.
    const spec = parseSceneSpec({ items });
    expect(spec).not.toBeNull();
    const whole = buildScene(spec!, { origin: { x: 0, y: 0 } });

    expect(streamed.length).toBe(whole.elements.length);
    expect(shapeOf(streamed)).toEqual(shapeOf(whole.elements));
  });
});

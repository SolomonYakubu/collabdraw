import { describe, expect, it } from "vitest";

import validation from "../validation.js";

const {
  MAX_SHAPES_PER_ROOM,
  MAX_SHAPES_PER_UPDATE,
  clampCoordinate,
  clampTag,
  isValidRoomId,
  sanitizeDeletedIds,
  sanitizeShapes,
} = validation;

const shape = (id) => ({ id, tool: "Square", x: 0, y: 0 });

describe("sanitizeShapes", () => {
  it("keeps well-formed shapes", () => {
    expect(sanitizeShapes([shape("a"), shape("b")])).toHaveLength(2);
  });

  it("rejects a non-array", () => {
    expect(sanitizeShapes(null)).toBeNull();
    expect(sanitizeShapes({ id: "a" })).toBeNull();
    expect(sanitizeShapes("nope")).toBeNull();
  });

  it("returns null rather than an empty array when nothing survives", () => {
    expect(sanitizeShapes([])).toBeNull();
    expect(sanitizeShapes([1, "x", null, []])).toBeNull();
  });

  it("drops entries with a missing or non-string id", () => {
    expect(sanitizeShapes([shape("a"), { tool: "Square" }, { id: 7 }])).toEqual([
      shape("a"),
    ]);
  });

  it("drops an id longer than 128 characters", () => {
    expect(sanitizeShapes([shape("x".repeat(129))])).toBeNull();
    expect(sanitizeShapes([shape("x".repeat(128))])).toHaveLength(1);
  });

  it("caps the count at MAX_SHAPES_PER_UPDATE", () => {
    const many = Array.from({ length: MAX_SHAPES_PER_UPDATE + 50 }, (_, i) =>
      shape(`s${i}`),
    );
    expect(sanitizeShapes(many)).toHaveLength(MAX_SHAPES_PER_UPDATE);
  });

  it("drops a shape over the per-shape byte cap", () => {
    const huge = { id: "big", blob: "x".repeat(33 * 1024) };
    expect(sanitizeShapes([huge, shape("a")])).toEqual([shape("a")]);
  });

  it("drops an unserializable (circular) shape rather than throwing", () => {
    const circular = { id: "loop" };
    circular.self = circular;
    expect(() => sanitizeShapes([circular])).not.toThrow();
    expect(sanitizeShapes([circular, shape("a")])).toEqual([shape("a")]);
  });
});

describe("sanitizeDeletedIds", () => {
  it("keeps bounded string ids", () => {
    expect(sanitizeDeletedIds(["a", "b"])).toEqual(["a", "b"]);
  });

  it("rejects a non-array and an all-invalid array", () => {
    expect(sanitizeDeletedIds("a")).toBeNull();
    expect(sanitizeDeletedIds([1, null, {}])).toBeNull();
  });

  it("drops over-long ids and caps the count", () => {
    expect(sanitizeDeletedIds(["ok", "x".repeat(129)])).toEqual(["ok"]);
    const many = Array.from({ length: MAX_SHAPES_PER_UPDATE + 10 }, (_, i) =>
      String(i),
    );
    expect(sanitizeDeletedIds(many)).toHaveLength(MAX_SHAPES_PER_UPDATE);
  });
});

describe("isValidRoomId", () => {
  it("accepts a non-empty bounded string", () => {
    expect(isValidRoomId("room-1")).toBe(true);
    expect(isValidRoomId("r".repeat(128))).toBe(true);
  });

  it("rejects empty, over-long, and non-string ids", () => {
    expect(isValidRoomId("")).toBe(false);
    expect(isValidRoomId("r".repeat(129))).toBe(false);
    expect(isValidRoomId(undefined)).toBe(false);
    expect(isValidRoomId(42)).toBe(false);
  });
});

describe("clampTag", () => {
  it("truncates to 64 characters", () => {
    expect(clampTag("n".repeat(80))).toHaveLength(64);
  });

  it("passes a short tag through and rejects a non-string", () => {
    expect(clampTag("Ada")).toBe("Ada");
    expect(clampTag(undefined)).toBeUndefined();
    expect(clampTag(7)).toBeUndefined();
  });
});

describe("clampCoordinate", () => {
  it("passes a finite number through", () => {
    expect(clampCoordinate(12.5)).toBe(12.5);
    expect(clampCoordinate(0)).toBe(0);
  });

  it("clamps to +/- 1e6", () => {
    expect(clampCoordinate(5e6)).toBe(1e6);
    expect(clampCoordinate(-5e6)).toBe(-1e6);
  });

  it("rejects non-finite and non-numeric input", () => {
    expect(clampCoordinate(Number.NaN)).toBeUndefined();
    expect(clampCoordinate(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(clampCoordinate("10")).toBeUndefined();
    expect(clampCoordinate(null)).toBeUndefined();
  });
});

describe("room cap", () => {
  it("retains more per room than any single update may carry", () => {
    expect(MAX_SHAPES_PER_ROOM).toBeGreaterThan(MAX_SHAPES_PER_UPDATE);
  });
});

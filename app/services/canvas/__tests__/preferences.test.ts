/**
 * Stored preferences. The interesting half is reading: the entry is a file the
 * user can edit and a format that will change, so every field has to survive
 * being wrong on its own without taking the others with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PREFERENCES,
  PREFERENCES_KEY,
  PREFERENCES_VERSION,
  readPreferences,
  writePreferences,
} from "../preferences";
import { DEFAULT_STYLE, ROUGHNESS } from "../../../types/shapes";

/** Minimal in-memory `localStorage`; this suite runs in the node environment. */
class MemoryStorage {
  private entries = new Map<string, string>();
  failOnWrite = false;
  failOnRead = false;

  getItem(key: string): string | null {
    if (this.failOnRead) {
      throw new Error("SecurityError");
    }
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failOnWrite) {
      const error = new Error("QuotaExceededError");
      error.name = "QuotaExceededError";
      throw error;
    }
    this.entries.set(key, value);
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }
}

let storage: MemoryStorage;

/** Put a raw entry in place, as a previous version or a text editor might. */
const store = (payload: unknown) =>
  storage.setItem(PREFERENCES_KEY, JSON.stringify(payload));

const storeStyle = (style: Record<string, unknown>) =>
  store({ version: PREFERENCES_VERSION, style, toolLocked: true });

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("window", { localStorage: storage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("writePreferences / readPreferences", () => {
  it("round-trips a whole set of preferences", () => {
    const preferences = {
      style: {
        ...DEFAULT_STYLE,
        stroke: "#e03131",
        fill: "#ffc9c9",
        fillStyle: "cross-hatch" as const,
        strokeWidth: 4,
        strokeStyle: "dashed" as const,
        roughness: ROUGHNESS.cartoonist,
        opacity: 30,
        edgeStyle: "elbow" as const,
      },
      toolLocked: false,
    };

    expect(writePreferences(preferences)).toBe(true);
    expect(readPreferences()).toEqual(preferences);
  });

  it("reads the defaults when nothing was ever written", () => {
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it("keeps the tool lock on by default", () => {
    expect(DEFAULT_PREFERENCES.toolLocked).toBe(true);
  });

  it("reports a refused write instead of throwing", () => {
    storage.failOnWrite = true;
    expect(writePreferences(DEFAULT_PREFERENCES)).toBe(false);
  });

  it("reads the defaults when storage refuses to be read", () => {
    storage.failOnRead = true;
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
  });
});

describe("a damaged entry", () => {
  it("falls back to the defaults when the payload is not JSON", () => {
    storage.setItem(PREFERENCES_KEY, "{not json");
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it("discards a version it does not recognise", () => {
    store({ version: 99, style: { stroke: "#e03131" }, toolLocked: false });
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it("discards an entry with no version at all", () => {
    store({ style: { stroke: "#e03131" } });
    expect(readPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it("survives a missing style object", () => {
    store({ version: PREFERENCES_VERSION, toolLocked: false });
    expect(readPreferences()).toEqual({
      style: DEFAULT_STYLE,
      toolLocked: false,
    });
  });

  it("keeps the good fields beside a bad one", () => {
    // One unusable value costs that setting, not the whole pen.
    storeStyle({ ...DEFAULT_STYLE, stroke: "#e03131", fillStyle: "tartan" });

    const { style } = readPreferences();
    expect(style.stroke).toBe("#e03131");
    expect(style.fillStyle).toBe(DEFAULT_STYLE.fillStyle);
  });

  it("ignores a non-boolean tool lock", () => {
    store({ version: PREFERENCES_VERSION, style: DEFAULT_STYLE, toolLocked: "yes" });
    expect(readPreferences().toolLocked).toBe(DEFAULT_PREFERENCES.toolLocked);
  });
});

describe("field validation", () => {
  it("accepts every member of the style unions", () => {
    for (const fillStyle of [
      "solid",
      "hachure",
      "zigzag",
      "cross-hatch",
      "dots",
      "dashed",
      "zigzag-line",
    ]) {
      storeStyle({ fillStyle });
      expect(readPreferences().style.fillStyle).toBe(fillStyle);
    }

    for (const strokeStyle of ["solid", "dashed", "dotted"]) {
      storeStyle({ strokeStyle });
      expect(readPreferences().style.strokeStyle).toBe(strokeStyle);
    }

    for (const edgeStyle of ["straight", "curved", "elbow"]) {
      storeStyle({ edgeStyle });
      expect(readPreferences().style.edgeStyle).toBe(edgeStyle);
    }
  });

  it("rejects a union member borrowed from Object.prototype", () => {
    // `"toString" in record` would have accepted this.
    storeStyle({ fillStyle: "toString", strokeStyle: "constructor" });

    const { style } = readPreferences();
    expect(style.fillStyle).toBe(DEFAULT_STYLE.fillStyle);
    expect(style.strokeStyle).toBe(DEFAULT_STYLE.strokeStyle);
  });

  it("clamps numbers into a range that renders", () => {
    storeStyle({
      strokeWidth: 10_000,
      opacity: -40,
      roughness: 9,
      fontSize: 0,
    });

    expect(readPreferences().style).toMatchObject({
      strokeWidth: 100,
      opacity: 10,
      roughness: 2,
      fontSize: 8,
    });
  });

  it("keeps a number the panel has no button for", () => {
    storeStyle({ strokeWidth: 3, opacity: 55 });

    expect(readPreferences().style).toMatchObject({
      strokeWidth: 3,
      opacity: 55,
    });
  });

  it("refuses numbers that are not numbers", () => {
    storeStyle({ strokeWidth: "4", opacity: null, roughness: NaN });

    expect(readPreferences().style).toMatchObject({
      strokeWidth: DEFAULT_STYLE.strokeWidth,
      opacity: DEFAULT_STYLE.opacity,
      roughness: DEFAULT_STYLE.roughness,
    });
  });

  it("refuses an empty or oversized colour", () => {
    storeStyle({ stroke: "", fill: "x".repeat(65) });

    expect(readPreferences().style).toMatchObject({
      stroke: DEFAULT_STYLE.stroke,
      fill: DEFAULT_STYLE.fill,
    });
  });

  it("accepts any colour notation CSS might", () => {
    storeStyle({ stroke: "rgb(224 49 49 / 60%)", fill: "transparent" });

    expect(readPreferences().style).toMatchObject({
      stroke: "rgb(224 49 49 / 60%)",
      fill: "transparent",
    });
  });
});

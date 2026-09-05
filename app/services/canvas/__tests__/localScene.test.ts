import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearLocalScene,
  loadLocalScene,
  LOCAL_SCENE_KEY,
  LOCAL_SCENE_VERSION,
  saveLocalScene,
} from "../localScene";
import type { Shape, Viewport } from "../../../types/shapes";

/**
 * Minimal in-memory `localStorage`. The suite runs in the `node` environment,
 * so there is no real one; `failOnWrite` stands in for a full quota, which is
 * the failure the caller is expected to tolerate.
 */
class MemoryStorage {
  private entries = new Map<string, string>();
  failOnWrite = false;

  getItem(key: string): string | null {
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

const square = (id: string): Shape =>
  ({
    id,
    tool: "Square",
    x: 10,
    y: 20,
    width: 30,
    height: 40,
  }) as unknown as Shape;

const viewport: Viewport = { zoom: 2, scroll: { x: -5, y: 15 } };

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("window", { localStorage: storage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("saveLocalScene / loadLocalScene", () => {
  it("round-trips elements and the viewport", () => {
    expect(saveLocalScene([square("a"), square("b")], viewport)).toBe(true);

    const restored = loadLocalScene();
    expect(restored.elements).toHaveLength(2);
    expect(restored.elements[0].tool).toBe("Square");
    expect(restored.viewport).toEqual(viewport);
  });

  it("reads an empty scene when nothing was ever saved", () => {
    expect(loadLocalScene()).toEqual({
      elements: [],
      viewport: null,
    });
  });

  it("reports failure instead of throwing when the quota is full", () => {
    storage.failOnWrite = true;
    expect(saveLocalScene([square("a")], viewport)).toBe(false);
  });

  it("degrades to an empty scene on unparseable JSON", () => {
    storage.setItem(LOCAL_SCENE_KEY, "{not json");
    expect(loadLocalScene().elements).toEqual([]);
  });

  it("ignores an entry written by a different format version", () => {
    storage.setItem(
      LOCAL_SCENE_KEY,
      JSON.stringify({
        version: LOCAL_SCENE_VERSION + 1,
        elements: [square("a")],
        viewport,
      }),
    );
    expect(loadLocalScene().elements).toEqual([]);
  });

  it("reads an entry from before the timestamp was dropped", () => {
    // Why the version did not need bumping: an unread field costs nothing.
    storage.setItem(
      LOCAL_SCENE_KEY,
      JSON.stringify({
        version: LOCAL_SCENE_VERSION,
        elements: [square("a")],
        viewport,
        savedAt: Date.now(),
      }),
    );
    expect(loadLocalScene().elements).toHaveLength(1);
    expect(loadLocalScene().viewport).toEqual(viewport);
  });

  it("drops shapes that are not valid elements", () => {
    storage.setItem(
      LOCAL_SCENE_KEY,
      JSON.stringify({
        version: LOCAL_SCENE_VERSION,
        elements: [square("a"), { tool: "NotATool" }, null, 7],
        viewport,
      }),
    );
    expect(loadLocalScene().elements).toHaveLength(1);
  });

  it("rejects a malformed viewport rather than restoring a broken one", () => {
    storage.setItem(
      LOCAL_SCENE_KEY,
      JSON.stringify({
        version: LOCAL_SCENE_VERSION,
        elements: [],
        viewport: { zoom: Number.NaN, scroll: { x: 0, y: 0 } },
      }),
    );
    expect(loadLocalScene().viewport).toBeNull();
  });

  it("survives storage that refuses to be read", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem() {
          throw new Error("blocked");
        },
      },
    });
    expect(loadLocalScene().elements).toEqual([]);
  });
});

describe("clearLocalScene", () => {
  it("forgets the saved scene", () => {
    saveLocalScene([square("a")], viewport);
    clearLocalScene();
    expect(loadLocalScene().elements).toEqual([]);
  });
});

// @vitest-environment jsdom
/**
 * The cadence of remembering the pen. What is stored and how it is validated is
 * `services/canvas/__tests__/preferences.test.ts`; what matters here is that the
 * defaults render first (a read during render would break hydration), that the
 * stored values arrive straight after, and that mounting never writes over them.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useEditorPreferences } from "../useEditorPreferences";
import {
  PREFERENCES_KEY,
  PREFERENCES_VERSION,
  readPreferences,
} from "../../services/canvas/preferences";
import { DEFAULT_STYLE } from "../../types/shapes";

/** Counts writes, so "did mounting persist anything?" is answerable. */
class MemoryStorage {
  private entries = new Map<string, string>();
  failOnWrite = false;
  writes = 0;

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes += 1;
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

const storePreferences = (
  style: Record<string, unknown>,
  toolLocked: boolean,
) => {
  storage.setItem(
    PREFERENCES_KEY,
    JSON.stringify({
      version: PREFERENCES_VERSION,
      style: { ...DEFAULT_STYLE, ...style },
      toolLocked,
    }),
  );
  storage.writes = 0;
};

beforeEach(() => {
  storage = new MemoryStorage();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
});

afterEach(cleanup);

describe("on mount", () => {
  it("adopts what was stored", () => {
    storePreferences({ stroke: "#e03131", strokeWidth: 4 }, false);

    const { result } = renderHook(() => useEditorPreferences());

    expect(result.current.style.stroke).toBe("#e03131");
    expect(result.current.style.strokeWidth).toBe(4);
    expect(result.current.toolLocked).toBe(false);
  });

  it("writes nothing, so the stored entry survives being read", () => {
    storePreferences({ stroke: "#e03131" }, false);

    renderHook(() => useEditorPreferences());

    expect(storage.writes).toBe(0);
  });

  it("starts from the defaults when there is nothing stored", () => {
    const { result } = renderHook(() => useEditorPreferences());

    expect(result.current.style).toEqual(DEFAULT_STYLE);
    expect(result.current.toolLocked).toBe(true);
  });
});

describe("changing a preference", () => {
  it("persists a style change and keeps the rest", () => {
    const { result } = renderHook(() => useEditorPreferences());

    act(() => result.current.setStyle({ ...DEFAULT_STYLE, opacity: 40 }));

    expect(result.current.style.opacity).toBe(40);
    expect(readPreferences().style.opacity).toBe(40);
    expect(readPreferences().style.stroke).toBe(DEFAULT_STYLE.stroke);
  });

  it("accepts an updater, which is how the style panel patches one field", () => {
    const { result } = renderHook(() => useEditorPreferences());

    act(() =>
      result.current.setStyle((current) => ({ ...current, stroke: "#1971c2" })),
    );
    act(() =>
      result.current.setStyle((current) => ({ ...current, fill: "#a5d8ff" })),
    );

    // The second updater saw the first change, rather than the initial state.
    expect(result.current.style).toMatchObject({
      stroke: "#1971c2",
      fill: "#a5d8ff",
    });
    expect(readPreferences().style).toMatchObject({
      stroke: "#1971c2",
      fill: "#a5d8ff",
    });
  });

  it("toggles the tool lock without disturbing the style", () => {
    storePreferences({ stroke: "#e03131" }, true);
    const { result } = renderHook(() => useEditorPreferences());

    act(() => result.current.setToolLocked((locked) => !locked));

    expect(result.current.toolLocked).toBe(false);
    expect(readPreferences()).toMatchObject({
      toolLocked: false,
      style: { stroke: "#e03131" },
    });
  });

  it("writes once per change", () => {
    const { result } = renderHook(() => useEditorPreferences());
    storage.writes = 0;

    act(() => result.current.setToolLocked(false));
    act(() => result.current.setStyle({ ...DEFAULT_STYLE, opacity: 20 }));

    expect(storage.writes).toBe(2);
  });

  it("still applies the change when storage refuses the write", () => {
    // A preference that cannot be stored is a preference for this session.
    storage.failOnWrite = true;
    const { result } = renderHook(() => useEditorPreferences());

    act(() => result.current.setToolLocked(false));

    expect(result.current.toolLocked).toBe(false);
  });
});

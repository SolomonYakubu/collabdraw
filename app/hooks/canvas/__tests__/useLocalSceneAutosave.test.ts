// @vitest-environment jsdom
/**
 * The autosave *cadence* — which is where the interesting bugs live. The write
 * itself is covered by `services/canvas/__tests__/localScene.test.ts`; what
 * matters here is when it happens, when it deliberately does not, and what the
 * caller is told when storage refuses it.
 */
import { useRef } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLocalSceneAutosave } from "../useLocalSceneAutosave";
import {
  LOCAL_SCENE_KEY,
  LOCAL_SCENE_VERSION,
  SAVE_DEBOUNCE_MS,
} from "../../../services/canvas/localScene";
import { STORAGE_SYNC_DEBOUNCE_MS } from "../../../services/storageSync";
import type { Shape, Viewport } from "../../../types/shapes";

/** Counts writes and can refuse them, standing in for a full quota. */
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

const shape = (id: string): Shape =>
  ({ id, tool: "Square", x: 0, y: 0, width: 10, height: 10 }) as unknown as Shape;

const viewport: Viewport = { zoom: 1, scroll: { x: 0, y: 0 } };

interface Props {
  enabled: boolean;
  elements: Shape[];
  onSaveOutcomeChange?: (saved: boolean) => void;
  onRemoteChange?: (elements: Shape[]) => void;
}

/** Mirrors how Canvas calls the hook: state plus a ref tracking it. */
const mount = (props: Props) =>
  renderHook(
    ({ enabled, elements, onSaveOutcomeChange, onRemoteChange }: Props) => {
      const elementsRef = useRef<Shape[]>(elements);
      elementsRef.current = elements;
      const viewportRef = useRef<Viewport>(viewport);
      return useLocalSceneAutosave({
        enabled,
        elements,
        elementsRef,
        viewport,
        viewportRef,
        onSaveOutcomeChange,
        onRemoteChange,
      });
    },
    { initialProps: props },
  );

const tick = (ms = SAVE_DEBOUNCE_MS) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

let storage: MemoryStorage;

const setDocumentVisibility = (hidden: boolean) => {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  storage = new MemoryStorage();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
  setDocumentVisibility(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("debounce", () => {
  it("writes nothing until the debounce window has elapsed", () => {
    mount({ enabled: true, elements: [shape("a")] });

    tick(SAVE_DEBOUNCE_MS - 1);
    expect(storage.writes).toBe(0);

    tick(1);
    expect(storage.writes).toBe(1);
  });

  it("coalesces a burst of edits into one write", () => {
    const { rerender } = mount({ enabled: true, elements: [shape("a")] });

    for (let i = 0; i < 5; i += 1) {
      rerender({ enabled: true, elements: [shape("a"), shape(`b${i}`)] });
      tick(50);
    }
    expect(storage.writes).toBe(0);

    tick();
    expect(storage.writes).toBe(1);
  });
});

describe("collaboration pause", () => {
  it("never writes while disabled, not even on the way out", () => {
    const { unmount } = mount({ enabled: false, elements: [shape("a")] });

    tick();
    unmount();
    expect(storage.writes).toBe(0);
  });

  it("writes nothing on the way *in* to a room", () => {
    /*
     * Joining a room flips `enabled` off, and that tears down the departure
     * listeners — whose teardown is itself a flush. By then the scene on screen
     * belongs to the room, so the flush has to check again: the stored entry is
     * the solo drawing, and writing the shared board over it loses it.
     */
    const { rerender } = mount({ enabled: true, elements: [shape("solo")] });
    tick();
    expect(storage.getItem(LOCAL_SCENE_KEY)).toContain("solo");

    rerender({ enabled: false, elements: [shape("room")] });

    expect(storage.writes).toBe(1);
    expect(storage.getItem(LOCAL_SCENE_KEY)).not.toContain("room");
  });
});

describe("hidden tab", () => {
  it("skips the debounced write while the tab is hidden", () => {
    setDocumentVisibility(true);
    mount({ enabled: true, elements: [shape("a")] });

    tick();
    expect(storage.writes).toBe(0);
  });

  it("flushes when the tab becomes hidden", () => {
    mount({ enabled: true, elements: [shape("a")] });

    setDocumentVisibility(true);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(storage.writes).toBe(1);
  });
});

describe("departure", () => {
  it("flushes on pagehide", () => {
    mount({ enabled: true, elements: [shape("a")] });

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(storage.writes).toBe(1);
  });

  it("flushes on unmount, before the debounce has fired", () => {
    const { unmount } = mount({ enabled: true, elements: [shape("a")] });

    tick(50);
    expect(storage.writes).toBe(0);

    unmount();
    expect(storage.writes).toBe(1);
  });
});

describe("refused writes", () => {
  it("reports a refusal once, however many attempts fail", () => {
    storage.failOnWrite = true;
    const onSaveOutcomeChange = vi.fn();
    const { rerender } = mount({
      enabled: true,
      elements: [shape("a")],
      onSaveOutcomeChange,
    });

    tick();
    for (let i = 0; i < 3; i += 1) {
      rerender({
        enabled: true,
        elements: [shape("a"), shape(`b${i}`)],
        onSaveOutcomeChange,
      });
      tick();
    }

    expect(storage.writes).toBeGreaterThan(1);
    expect(onSaveOutcomeChange).toHaveBeenCalledTimes(1);
    expect(onSaveOutcomeChange).toHaveBeenCalledWith(false);
  });

  it("reports recovery when writing works again", () => {
    storage.failOnWrite = true;
    const onSaveOutcomeChange = vi.fn();
    const { rerender } = mount({
      enabled: true,
      elements: [shape("a")],
      onSaveOutcomeChange,
    });

    tick();
    expect(onSaveOutcomeChange).toHaveBeenLastCalledWith(false);

    storage.failOnWrite = false;
    rerender({
      enabled: true,
      elements: [shape("a"), shape("b")],
      onSaveOutcomeChange,
    });
    tick();

    expect(onSaveOutcomeChange).toHaveBeenCalledTimes(2);
    expect(onSaveOutcomeChange).toHaveBeenLastCalledWith(true);
  });

  it("says nothing at all while writes keep succeeding", () => {
    const onSaveOutcomeChange = vi.fn();
    const { rerender, unmount } = mount({
      enabled: true,
      elements: [shape("a")],
      onSaveOutcomeChange,
    });

    tick();
    rerender({
      enabled: true,
      elements: [shape("a"), shape("b")],
      onSaveOutcomeChange,
    });
    tick();
    unmount();

    expect(storage.writes).toBeGreaterThan(0);
    expect(onSaveOutcomeChange).not.toHaveBeenCalled();
  });
});

/**
 * The merge itself is `services/canvas/__tests__/reconcileLocalScene.test.ts`;
 * what belongs here is the plumbing — that another tab's save is heard at all,
 * that this tab's own ids are treated as shared, and that an unchanged scene is
 * not handed back (which is what stops the two tabs answering each other).
 */
describe("cross-tab merging", () => {
  /** Stand in for the other tab: write the store, then raise the event. */
  const otherTabSaves = (elements: Shape[]) => {
    storage.setItem(
      LOCAL_SCENE_KEY,
      JSON.stringify({
        version: LOCAL_SCENE_VERSION,
        elements,
        viewport,
      }),
    );
    notify();
  };

  /**
   * A real `storage` event carries a `storageArea`, but jsdom will only accept a
   * genuine `Storage` there and this suite runs on a stub. Omitting it is what
   * the spec allows and the listener tolerates.
   */
  const notify = () =>
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: LOCAL_SCENE_KEY }),
      );
      vi.advanceTimersByTime(STORAGE_SYNC_DEBOUNCE_MS);
    });

  const ids = (elements: readonly Shape[]) =>
    elements.map((element) => element.id);

  it("hands back a scene containing what another tab drew", () => {
    const onRemoteChange = vi.fn();
    mount({ enabled: true, elements: [shape("a")], onRemoteChange });

    otherTabSaves([shape("a"), shape("theirs")]);

    expect(onRemoteChange).toHaveBeenCalledTimes(1);
    expect(ids(onRemoteChange.mock.calls[0][0])).toEqual(["a", "theirs"]);
  });

  it("keeps what only this tab has drawn while adopting theirs", () => {
    const onRemoteChange = vi.fn();
    mount({
      enabled: true,
      elements: [shape("a"), shape("unshared")],
      onRemoteChange,
    });

    otherTabSaves([shape("a"), shape("theirs")]);

    expect(ids(onRemoteChange.mock.calls[0][0])).toEqual([
      "a",
      "theirs",
      "unshared",
    ]);
  });

  it("honours a deletion made in the other tab", () => {
    // Both ids are in the store before this tab mounts, so both are shared and
    // their later absence is a deletion rather than an unseen element.
    const onRemoteChange = vi.fn();
    storage.setItem(
      LOCAL_SCENE_KEY,
      JSON.stringify({
        version: LOCAL_SCENE_VERSION,
        elements: [shape("a"), shape("b")],
        viewport,
      }),
    );
    mount({
      enabled: true,
      elements: [shape("a"), shape("b")],
      onRemoteChange,
    });

    otherTabSaves([shape("a")]);

    expect(ids(onRemoteChange.mock.calls[0][0])).toEqual(["a"]);
  });

  it("treats ids it has written as shared, so a later deletion counts", () => {
    // Same as above, but this tab learns the ids by saving them itself.
    const onRemoteChange = vi.fn();
    mount({
      enabled: true,
      elements: [shape("a"), shape("b")],
      onRemoteChange,
    });
    tick();

    otherTabSaves([shape("a")]);

    expect(ids(onRemoteChange.mock.calls[0][0])).toEqual(["a"]);
  });

  it("follows the other tab clearing the canvas", () => {
    const onRemoteChange = vi.fn();
    mount({ enabled: true, elements: [shape("a")], onRemoteChange });
    tick();

    storage.removeItem(LOCAL_SCENE_KEY);
    notify();

    expect(onRemoteChange).toHaveBeenCalledTimes(1);
    expect(onRemoteChange.mock.calls[0][0]).toEqual([]);
  });

  it("stays quiet when the other tab saved the same scene", () => {
    const onRemoteChange = vi.fn();
    mount({ enabled: true, elements: [shape("a")], onRemoteChange });

    otherTabSaves([shape("a")]);

    expect(onRemoteChange).not.toHaveBeenCalled();
  });

  it("ignores another tab entirely while collaborating", () => {
    // In a room the server owns the scene; localStorage is not a party to it.
    const onRemoteChange = vi.fn();
    mount({ enabled: false, elements: [shape("a")], onRemoteChange });

    otherTabSaves([shape("a"), shape("theirs")]);

    expect(onRemoteChange).not.toHaveBeenCalled();
  });

  it("stops listening once unmounted", () => {
    const onRemoteChange = vi.fn();
    const { unmount } = mount({
      enabled: true,
      elements: [shape("a")],
      onRemoteChange,
    });

    unmount();
    otherTabSaves([shape("a"), shape("theirs")]);

    expect(onRemoteChange).not.toHaveBeenCalled();
  });
});

/**
 * "Reset the canvas". The awkward part is that a reset empties the canvas, which
 * is a change like any other — so the same debounce that saves your work will
 * happily save the emptiness back over the entry the reset just removed.
 */
describe("clearSavedScene", () => {
  const stored = () => storage.getItem(LOCAL_SCENE_KEY);

  it("removes the stored entry", () => {
    const { result } = mount({ enabled: true, elements: [shape("a")] });
    tick();
    expect(stored()).not.toBeNull();

    act(() => result.current.clearSavedScene());

    expect(stored()).toBeNull();
  });

  it("keeps it removed when the canvas empties, as a reset does", () => {
    const { rerender, result, unmount } = mount({
      enabled: true,
      elements: [shape("a")],
    });
    tick();

    act(() => result.current.clearSavedScene());
    rerender({ enabled: true, elements: [] });
    tick();
    expect(stored()).toBeNull();

    // Nor on the way out, which flushes.
    unmount();
    expect(stored()).toBeNull();
  });

  it("saves again as soon as something is drawn", () => {
    const { rerender, result } = mount({
      enabled: true,
      elements: [shape("a")],
    });
    tick();
    act(() => result.current.clearSavedScene());
    rerender({ enabled: true, elements: [] });
    tick();

    rerender({ enabled: true, elements: [shape("b")] });
    tick();

    expect(stored()).toContain("b");
  });

  it("declines inside a room, where the entry is the solo drawing", () => {
    storage.setItem(
      LOCAL_SCENE_KEY,
      JSON.stringify({
        version: LOCAL_SCENE_VERSION,
        elements: [shape("solo")],
        viewport,
      }),
    );
    const { result } = mount({ enabled: false, elements: [shape("a")] });

    act(() => result.current.clearSavedScene());

    expect(stored()).toContain("solo");
  });
});

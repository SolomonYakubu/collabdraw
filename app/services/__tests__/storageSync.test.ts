// @vitest-environment jsdom
/**
 * The cross-tab channel. What matters is that a listener hears the *other* tab's
 * writes, hears them once per burst, and reads the settled value rather than
 * whatever a single event happened to carry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  STORAGE_SYNC_DEBOUNCE_MS,
  subscribeToStorageKey,
} from "../storageSync";

const KEY = "collabdraw_scene";

/** What the browser sends other tabs; jsdom never synthesises these itself. */
const dispatch = (
  init: { key?: string | null; newValue?: string | null; area?: Storage } = {},
) =>
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: init.key === undefined ? KEY : init.key,
      newValue: init.newValue ?? null,
      storageArea: init.area ?? window.localStorage,
    }),
  );

const settle = (ms = STORAGE_SYNC_DEBOUNCE_MS) => vi.advanceTimersByTime(ms);

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("subscribeToStorageKey", () => {
  it("reports what the other tab wrote", () => {
    const onChange = vi.fn();
    subscribeToStorageKey(KEY, onChange);

    window.localStorage.setItem(KEY, "scene-1");
    dispatch({ newValue: "scene-1" });

    expect(onChange).not.toHaveBeenCalled();
    settle();
    expect(onChange).toHaveBeenCalledExactlyOnceWith("scene-1");
  });

  it("coalesces a burst and reports only the settled value", () => {
    const onChange = vi.fn();
    subscribeToStorageKey(KEY, onChange);

    for (const value of ["one", "two", "three"]) {
      window.localStorage.setItem(KEY, value);
      dispatch({ newValue: value });
      settle(STORAGE_SYNC_DEBOUNCE_MS - 1);
    }

    settle();
    expect(onChange).toHaveBeenCalledExactlyOnceWith("three");
  });

  it("re-reads storage rather than trusting the event's newValue", () => {
    const onChange = vi.fn();
    subscribeToStorageKey(KEY, onChange);

    window.localStorage.setItem(KEY, "what-is-actually-stored");
    dispatch({ newValue: "a-stale-intermediate-value" });
    settle();

    expect(onChange).toHaveBeenCalledWith("what-is-actually-stored");
  });

  it("reports null when the entry was removed", () => {
    const onChange = vi.fn();
    subscribeToStorageKey(KEY, onChange);

    dispatch({ newValue: null });
    settle();

    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("treats a null key as the whole store being cleared", () => {
    const onChange = vi.fn();
    window.localStorage.setItem(KEY, "scene-1");
    subscribeToStorageKey(KEY, onChange);

    window.localStorage.clear();
    dispatch({ key: null });
    settle();

    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("ignores other keys", () => {
    const onChange = vi.fn();
    subscribeToStorageKey(KEY, onChange);

    dispatch({ key: "collabdraw_userName", newValue: "Ada" });
    settle();

    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores sessionStorage, which is not shared between tabs", () => {
    const onChange = vi.fn();
    subscribeToStorageKey(KEY, onChange);

    dispatch({ area: window.sessionStorage, newValue: "scene-1" });
    settle();

    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports null when reading storage throws", () => {
    const onChange = vi.fn();
    // Spied on the prototype rather than swapped for a stub object: the event's
    // `storageArea` has to stay a real `Storage` for the guard to accept it.
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    subscribeToStorageKey(KEY, onChange);

    dispatch();
    settle();

    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("stops listening, and cancels a pending report, on unsubscribe", () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeToStorageKey(KEY, onChange);

    window.localStorage.setItem(KEY, "scene-1");
    dispatch({ newValue: "scene-1" });
    unsubscribe();
    settle();
    expect(onChange).not.toHaveBeenCalled();

    dispatch({ newValue: "scene-2" });
    settle();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps two subscriptions to one key independent", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeToStorageKey(KEY, first);
    subscribeToStorageKey(KEY, second);

    window.localStorage.setItem(KEY, "scene-1");
    dispatch({ newValue: "scene-1" });
    settle();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    dispatch({ newValue: "scene-1" });
    settle();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });
});

// @vitest-environment jsdom
/**
 * Theme selection: a three-state preference resolved against the OS setting.
 *
 * Two failures shape these tests. Reading `localStorage` during render would
 * make the server's markup disagree with the client's first paint, so the stored
 * choice can only be adopted in an effect — which means the first render is
 * always the default, and the tests below say so rather than letting a future
 * change quietly move the read. The other is that nothing reads the returned
 * `theme` directly: the CSS tokens key off `data-theme` on the document element,
 * so a theme that fails to reach that attribute leaves the whole app light with
 * a toggle that appears to do nothing.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTheme, type ThemePreference } from "../useTheme";

const STORAGE_KEY = "collabdraw_theme";

/** Lets a test throw from storage, as Safari's private mode does. */
class MemoryStorage {
  private entries = new Map<string, string>();
  failOnRead = false;
  failOnWrite = false;

  getItem(key: string): string | null {
    if (this.failOnRead) {
      throw new Error("SecurityError");
    }
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failOnWrite) {
      throw new Error("QuotaExceededError");
    }
    this.entries.set(key, value);
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }
}

let storage: MemoryStorage;
/** The listeners `useTheme` registered on the media query, by event name. */
let mediaListeners: Array<() => void>;
let removedListeners: number;
let systemPrefersDark: boolean;

/** Flips the OS setting and tells whoever is listening, as the browser would. */
const setSystemDark = (dark: boolean) => {
  systemPrefersDark = dark;
  act(() => {
    for (const listener of mediaListeners) {
      listener();
    }
  });
};

beforeEach(() => {
  storage = new MemoryStorage();
  mediaListeners = [];
  removedListeners = 0;
  systemPrefersDark = false;

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      media: query,
      // Read at call time, so a later flip is visible to the next query.
      get matches() {
        return systemPrefersDark;
      },
      addEventListener: (_: string, listener: () => void) => {
        mediaListeners.push(listener);
      },
      removeEventListener: () => {
        removedListeners += 1;
      },
    }),
  });

  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.colorScheme = "";
});

afterEach(cleanup);

describe("on mount", () => {
  it("renders the default before it reads storage", () => {
    /*
     * The first render has to match what the server sent, whatever is stored, or
     * React discards the markup and hydration warns. Every render is recorded so
     * the assertion is about the first one specifically.
     */
    storage.setItem(STORAGE_KEY, "dark");
    const seen: ThemePreference[] = [];

    renderHook(() => {
      const state = useTheme();
      seen.push(state.preference);
      return state;
    });

    expect(seen[0]).toBe("system");
    // And the stored choice has arrived by the time the effects have run.
    expect(seen[seen.length - 1]).toBe("dark");
  });

  it("adopts the stored preference", () => {
    storage.setItem(STORAGE_KEY, "light");

    const { result } = renderHook(() => useTheme());

    expect(result.current.preference).toBe("light");
    expect(result.current.theme).toBe("light");
  });

  it("follows the system when nothing is stored", () => {
    systemPrefersDark = true;

    const { result } = renderHook(() => useTheme());

    expect(result.current.preference).toBe("system");
    expect(result.current.theme).toBe("dark");
  });

  it("ignores a stored value that is not one of the three", () => {
    // Anything else is a stale key from an older build or a hand-edited entry;
    // trusting it would write it straight back to `data-theme`.
    storage.setItem(STORAGE_KEY, "midnight");

    const { result } = renderHook(() => useTheme());

    expect(result.current.preference).toBe("system");
  });

  it("falls back to the system when storage cannot be read at all", () => {
    // A blocked `localStorage` throws on access rather than returning null, and
    // an uncaught throw here would take the whole editor down on load.
    storage.failOnRead = true;
    systemPrefersDark = true;

    const { result } = renderHook(() => useTheme());

    expect(result.current.preference).toBe("system");
    expect(result.current.theme).toBe("dark");
  });
});

describe("the document element", () => {
  it("carries the resolved theme, not the preference", () => {
    // "system" is not a theme any stylesheet can use.
    systemPrefersDark = true;

    renderHook(() => useTheme());

    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("sets colorScheme so the browser's own chrome matches", () => {
    // Scrollbars and form controls are drawn by the browser, which only knows
    // about the theme through this property.
    systemPrefersDark = true;

    renderHook(() => useTheme());

    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("follows a later change", () => {
    const { result } = renderHook(() => useTheme());
    expect(document.documentElement.dataset.theme).toBe("light");

    act(() => result.current.setPreference("dark"));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });
});

describe("following the system", () => {
  it("re-resolves when the OS setting flips", () => {
    // The user changes their OS appearance while the board is open; nothing
    // re-mounts, so the media query listener is the only signal.
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");

    setSystemDark(true);

    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("leaves an explicit choice alone when the OS flips", () => {
    storage.setItem(STORAGE_KEY, "light");
    const { result } = renderHook(() => useTheme());

    setSystemDark(true);

    expect(result.current.theme).toBe("light");
  });

  it("stops listening once unmounted", () => {
    // The listener holds the setState of a component that is gone; leaving it
    // attached warns on every OS change for the rest of the session.
    const { unmount } = renderHook(() => useTheme());

    unmount();

    expect(removedListeners).toBe(1);
  });
});

describe("setPreference", () => {
  it("remembers the choice for the next visit", () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setPreference("dark"));

    expect(result.current.preference).toBe("dark");
    expect(storage.getItem(STORAGE_KEY)).toBe("dark");
  });

  it("still changes the theme when the choice cannot be stored", () => {
    // A full or blocked storage costs the user their choice on the next load,
    // which is not a reason to refuse the change they just made.
    storage.failOnWrite = true;
    const { result } = renderHook(() => useTheme());

    act(() => result.current.setPreference("dark"));

    expect(result.current.theme).toBe("dark");
  });
});

describe("cycle", () => {
  it("steps light, dark, system and back to light", () => {
    // One button for three states, so the order is the whole interface: every
    // state has to be reachable by pressing again.
    storage.setItem(STORAGE_KEY, "light");
    const { result } = renderHook(() => useTheme());

    act(() => result.current.cycle());
    expect(result.current.preference).toBe("dark");

    act(() => result.current.cycle());
    expect(result.current.preference).toBe("system");

    act(() => result.current.cycle());
    expect(result.current.preference).toBe("light");
  });

  it("starts at light from the system default", () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.cycle());

    expect(result.current.preference).toBe("light");
  });

  it("persists each step, so the cycle survives a reload", () => {
    const { result } = renderHook(() => useTheme());

    act(() => result.current.cycle());

    expect(storage.getItem(STORAGE_KEY)).toBe("light");
  });
});

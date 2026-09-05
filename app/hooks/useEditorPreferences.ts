"use client";

/**
 * The pen, remembered.
 *
 * A drop-in pair of `useState`s for the style panel and the tool lock, except
 * that changes are written to localStorage and the last ones are read back on
 * mount. See `services/canvas/preferences` for what is stored and why it is not
 * part of the saved scene.
 *
 * Two deliberate omissions:
 *
 *  - **Nothing is read during render.** Reading localStorage while rendering
 *    gives the server and the client different HTML, and React answers a
 *    mismatch by throwing the hydrated tree away. The defaults render, and the
 *    effect below corrects them before anyone can draw — the same approach as
 *    `useTheme`.
 *  - **No cross-tab sync.** Unlike the scene, which two tabs share and must
 *    agree on, your pen is yours per tab: having a colour change under you
 *    because you picked a different one next door would be worse than having two
 *    tabs disagree.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  DEFAULT_PREFERENCES,
  type EditorPreferences,
  readPreferences,
  writePreferences,
} from "../services/canvas/preferences";
import type { ElementStyle } from "../types/shapes";

/** Matches a `useState` setter, so both forms of update work. */
type Update<T> = T | ((previous: T) => T);

const resolve = <T,>(update: Update<T>, previous: T): T =>
  typeof update === "function" ? (update as (previous: T) => T)(previous) : update;

export interface EditorPreferencesState {
  style: ElementStyle;
  setStyle: (update: Update<ElementStyle>) => void;
  toolLocked: boolean;
  setToolLocked: (update: Update<boolean>) => void;
}

export const useEditorPreferences = (): EditorPreferencesState => {
  const [preferences, setPreferences] =
    useState<EditorPreferences>(DEFAULT_PREFERENCES);

  /**
   * The same value as the state, but readable now. The setters need the previous
   * preferences to resolve an updater and to persist the untouched half, and
   * doing that inside a state updater would write to storage from a function
   * React is free to call twice.
   */
  const currentRef = useRef<EditorPreferences>(DEFAULT_PREFERENCES);

  useEffect(() => {
    const stored = readPreferences();
    currentRef.current = stored;
    setPreferences(stored);
  }, []);

  const update = useCallback((patch: Partial<EditorPreferences>) => {
    const next = { ...currentRef.current, ...patch };
    currentRef.current = next;
    setPreferences(next);
    // Best effort: a refused write costs the preference, not the drawing.
    writePreferences(next);
  }, []);

  const setStyle = useCallback(
    (next: Update<ElementStyle>) => {
      update({ style: resolve(next, currentRef.current.style) });
    },
    [update],
  );

  const setToolLocked = useCallback(
    (next: Update<boolean>) => {
      update({ toolLocked: resolve(next, currentRef.current.toolLocked) });
    },
    [update],
  );

  return {
    style: preferences.style,
    setStyle,
    toolLocked: preferences.toolLocked,
    setToolLocked,
  };
};

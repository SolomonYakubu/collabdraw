"use client";

/**
 * Autosave to localStorage — what makes the canvas at `/` still be there
 * tomorrow without anyone signing in.
 *
 * Three behaviours copied from excalidraw.com, for the same reasons:
 *
 *  - **Debounced.** Writing on every stroke would serialise the whole scene
 *    dozens of times a second. Excalidraw uses a 300ms debounce; so does this.
 *  - **Paused inside a room.** In a collaboration room the server holds the
 *    authoritative merged scene, so a client writing its own view of it to
 *    localStorage would just create a second, staler copy. Excalidraw locks
 *    saving with a `"collaboration"` lock; here the caller passes
 *    `enabled: false` whenever a board id is present.
 *  - **Skipped while hidden, flushed on hide.** A background tab has nothing
 *    new to save, but the moment it is hidden is the last chance to write —
 *    closing a tab fires `pagehide`, not a final render.
 *
 * A write can be refused — a full quota is the realistic case — and then the
 * drawing only exists in memory. That is worth saying out loud, so the outcome
 * is reported to the caller through `onSaveOutcomeChange`.
 *
 * One behaviour is *not* copied: excalidraw.com lets the last tab to save win.
 * Because there is one key holding the whole scene, that means drawing in a
 * second tab discards whatever the first one did. Instead, another tab's save is
 * heard (`storageSync`) and merged (`reconcileScenes`), and the result is handed
 * back through `onRemoteChange`. The three above are not the whole of the
 * resemblance and this is not the whole of the divergence: ARCHITECTURE.md's
 * "What we deliberately did not copy" carries the rest, none of which is this
 * hook's business.
 */
import { useCallback, useEffect, useRef } from "react";

import {
  LOCAL_SCENE_KEY,
  SAVE_DEBOUNCE_MS,
  clearLocalScene,
  loadLocalScene,
  saveLocalScene,
} from "../../services/canvas/localScene";
import { reconcileScenes } from "../../services/canvas/reconcileLocalScene";
import { subscribeToStorageKey } from "../../services/storageSync";
import type { Shape, Viewport } from "../../types/shapes";

interface UseLocalSceneAutosaveOptions {
  /** False inside a collaboration room, where the server owns the scene. */
  enabled: boolean;
  /** Change signal — the current element array from `useScene`. */
  elements: readonly Shape[];
  elementsRef: React.MutableRefObject<Shape[]>;
  /** Change signal — pan and zoom are restored alongside the elements. */
  viewport: Viewport;
  viewportRef: React.MutableRefObject<Viewport>;
  /**
   * Called when the *outcome* of saving changes: `false` the first time a write
   * is refused, `true` again once one succeeds. Edge-triggered on purpose — a
   * full quota fails on every debounce tick, and one warning per tick would be
   * unreadable. A healthy start is assumed, so a working canvas says nothing.
   */
  onSaveOutcomeChange?: (saved: boolean) => void;
  /**
   * Called with the merged scene when another tab saves a different one. Not
   * called when the merge changes nothing, so an idle pair of tabs stays idle.
   * Omit it to keep the old last-writer-wins behaviour.
   */
  onRemoteChange?: (elements: Shape[]) => void;
}

export interface LocalSceneAutosave {
  /**
   * Forget the stored scene — what "Reset the canvas" needs. Removing the entry
   * is only half of it: the reset also empties the canvas, and that is a change
   * like any other, so the debounced write would put an empty entry straight
   * back. This suppresses that write, and every one after it, until something is
   * drawn again. A no-op inside a room, where the stored scene is the solo
   * drawing you left behind rather than the one on screen.
   */
  clearSavedScene: () => void;
}

export function useLocalSceneAutosave({
  enabled,
  elements,
  elementsRef,
  viewport,
  viewportRef,
  onSaveOutcomeChange,
  onRemoteChange,
}: UseLocalSceneAutosaveOptions): LocalSceneAutosave {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const onSaveOutcomeChangeRef = useRef(onSaveOutcomeChange);
  onSaveOutcomeChangeRef.current = onSaveOutcomeChange;

  const onRemoteChangeRef = useRef(onRemoteChange);
  onRemoteChangeRef.current = onRemoteChange;

  /*
   * The subscription turns on the presence of a handler, not its identity: a
   * caller that rebuilds the callback each render would otherwise tear down and
   * re-seed the listener on every pointer move.
   */
  const wantsRemoteChanges = Boolean(onRemoteChange);

  /** The last outcome handed to the caller; starts optimistic (see above). */
  const lastOutcomeRef = useRef(true);

  /**
   * Every id this tab has exchanged with the store. `reconcileScenes` needs it
   * to tell "the other tab deleted this" from "the other tab has not seen this
   * yet", there being no tombstones. It only ever grows: a deleted id has to
   * stay, because it *is* the record of the deletion.
   */
  const knownIdsRef = useRef<Set<string>>(new Set());

  const remember = useCallback((shared: readonly Shape[]) => {
    for (const element of shared) {
      knownIdsRef.current.add(element.id);
    }
  }, []);

  /**
   * Set when the entry is removed on purpose, and cleared again by the first
   * save that has something in it. It is what makes a reset stick: see
   * `clearSavedScene`.
   */
  const clearedRef = useRef(false);

  const save = useCallback(() => {
    if (clearedRef.current) {
      if (elementsRef.current.length === 0) {
        // The entry was removed and nothing has been drawn since, so there is
        // nothing to write — and writing anyway would undo the reset.
        return;
      }
      clearedRef.current = false;
    }

    const saved = saveLocalScene(elementsRef.current, viewportRef.current);
    if (saved) {
      // Published, so another tab dropping any of these ids means a deletion.
      remember(elementsRef.current);
    }
    if (saved !== lastOutcomeRef.current) {
      lastOutcomeRef.current = saved;
      onSaveOutcomeChangeRef.current?.(saved);
    }
  }, [elementsRef, remember, viewportRef]);

  const clearSavedScene = useCallback(() => {
    // Inside a room the stored scene is not the one on screen; leave it alone.
    if (!enabledRef.current) {
      return;
    }
    clearLocalScene();
    clearedRef.current = true;
  }, []);

  /* Debounced write on every scene or viewport change. */
  useEffect(() => {
    if (!enabled || document.hidden) {
      return;
    }

    const timer = window.setTimeout(save, SAVE_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [elements, enabled, save, viewport]);

  /* Last chance to write: the tab is going away or being backgrounded. */
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const flush = () => {
      if (!enabledRef.current) {
        return;
      }
      save();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flush();
      }
    };

    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      // Unmounting is also a departure (a client-side navigation into a room),
      // so persist what is on screen before the component goes.
      flush();
    };
  }, [enabled, save]);

  /* Merge what another tab saves instead of overwriting it on the next tick. */
  useEffect(() => {
    if (!enabled || !wantsRemoteChanges) {
      return;
    }

    // Seeded from the store rather than from local state, that being the
    // definition of "shared". Seeding short only makes the merge conservative —
    // an unknown id is kept, never treated as deleted — so a tab that could not
    // read the store cannot wipe the tab that can.
    remember(loadLocalScene().elements);

    return subscribeToStorageKey(LOCAL_SCENE_KEY, () => {
      // A removed entry reads as an empty scene, which is the right reading:
      // the other tab reset its canvas, and this one follows.
      const incoming = loadLocalScene().elements;
      const next = reconcileScenes(
        elementsRef.current,
        incoming,
        knownIdsRef.current,
      );

      // After the merge, never before: an incoming id already counted as known
      // would look like one this tab had deleted.
      remember(incoming);
      remember(next);

      // Reference-equal means the merge settled, and answering would start a
      // write-and-merge exchange between the tabs that never ends.
      if (next !== elementsRef.current) {
        onRemoteChangeRef.current?.(next);
      }
    });
  }, [elementsRef, enabled, remember, wantsRemoteChanges]);

  return { clearSavedScene };
}

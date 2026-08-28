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
 */
import { useEffect, useRef } from "react";

import {
  SAVE_DEBOUNCE_MS,
  saveLocalScene,
} from "../../services/canvas/localScene";
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
}

export function useLocalSceneAutosave({
  enabled,
  elements,
  elementsRef,
  viewport,
  viewportRef,
}: UseLocalSceneAutosaveOptions): void {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  /* Debounced write on every scene or viewport change. */
  useEffect(() => {
    if (!enabled || document.hidden) {
      return;
    }

    const timer = window.setTimeout(() => {
      saveLocalScene(elementsRef.current, viewportRef.current);
    }, SAVE_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [elements, enabled, elementsRef, viewport, viewportRef]);

  /* Last chance to write: the tab is going away or being backgrounded. */
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const flush = () => {
      if (!enabledRef.current) {
        return;
      }
      saveLocalScene(elementsRef.current, viewportRef.current);
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
  }, [enabled, elementsRef, viewportRef]);
}

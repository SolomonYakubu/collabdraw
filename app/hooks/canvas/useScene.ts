"use client";

/**
 * Scene state and undo/redo.
 *
 * Owns the element list and the history stack together, because the two must
 * agree: the old `useHistory` snapshotted the `shapes` value captured in the
 * render *before* the change, so every undo replayed one action too few and the
 * very first shape drawn could never be undone.
 *
 * Here, mutations go through `applyElements`, which computes the next array
 * from a synchronously-maintained ref and pushes exactly that array onto the
 * history stack.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type { Shape } from "../../types/shapes";
import { removeStaleBindings } from "../../services/canvas/bindings";

const MAX_HISTORY = 100;

export type ElementsUpdater = Shape[] | ((prev: Shape[]) => Shape[]);

export interface ApplyOptions {
  /** Push the result onto the undo stack. Default true. */
  commit?: boolean;
  /**
   * How to tell collaborators. `"full"` sends the whole scene (needed for
   * reordering, undo, clear); `"none"` stays local; otherwise the changed
   * elements are sent individually.
   */
  broadcast?: "none" | "full" | "elements";
  /** Ids to send when `broadcast` is `"elements"`. */
  changedIds?: readonly string[];
  /** Ids that were removed, so peers can delete them too. */
  deletedIds?: readonly string[];
  /** Drop bindings whose targets have gone. Default true. */
  reconcileBindings?: boolean;
}

export interface SceneBroadcast {
  elements: Shape[];
  changed: Shape[];
  deletedIds: string[];
  mode: "none" | "full" | "elements";
}

export interface UseSceneOptions {
  initialElements?: Shape[];
  /** Called after every applied change so the caller can sync collaborators. */
  onChange?: (payload: SceneBroadcast) => void;
}

export interface Scene {
  elements: Shape[];
  elementsRef: React.MutableRefObject<Shape[]>;
  applyElements: (updater: ElementsUpdater, options?: ApplyOptions) => Shape[];
  commit: (elements?: Shape[]) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  resetHistory: (elements: Shape[]) => void;
}

export const useScene = ({
  initialElements = [],
  onChange,
}: UseSceneOptions = {}): Scene => {
  const [elements, setElements] = useState<Shape[]>(initialElements);

  // Updated synchronously on every write so several mutations in one tick see
  // each other, which plain state would not guarantee.
  const elementsRef = useRef<Shape[]>(initialElements);

  const historyRef = useRef<Shape[][]>([initialElements]);
  const historyIndexRef = useRef(0);
  const [historyVersion, setHistoryVersion] = useState(0);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const write = useCallback((next: Shape[]) => {
    elementsRef.current = next;
    setElements(next);
  }, []);

  const commit = useCallback((next?: Shape[]) => {
    const snapshot = next ?? elementsRef.current;
    const history = historyRef.current;
    const index = historyIndexRef.current;

    // Skip no-op commits so undo never needs two presses for one action.
    const current = history[index];
    if (current && current.length === snapshot.length) {
      let identical = true;
      for (let i = 0; i < snapshot.length; i += 1) {
        if (
          current[i] !== snapshot[i] &&
          (current[i]?.id !== snapshot[i]?.id ||
            current[i]?.version !== snapshot[i]?.version)
        ) {
          identical = false;
          break;
        }
      }
      if (identical) {
        return;
      }
    }

    const trimmed = history.slice(0, index + 1);
    trimmed.push(snapshot);

    const overflow = Math.max(0, trimmed.length - MAX_HISTORY);
    historyRef.current = trimmed.slice(overflow);
    historyIndexRef.current = historyRef.current.length - 1;

    setHistoryVersion((version) => version + 1);
  }, []);

  const applyElements = useCallback(
    (updater: ElementsUpdater, options: ApplyOptions = {}): Shape[] => {
      const {
        commit: shouldCommit = true,
        broadcast = "elements",
        changedIds,
        deletedIds = [],
        reconcileBindings = true,
      } = options;

      const previous = elementsRef.current;
      let next =
        typeof updater === "function" ? updater(previous) : updater;

      if (next === previous) {
        return previous;
      }

      if (reconcileBindings && next.length !== previous.length) {
        next = removeStaleBindings(next);
      }

      write(next);

      if (shouldCommit) {
        commit(next);
      }

      const emit = onChangeRef.current;
      if (emit && broadcast !== "none") {
        let changed: Shape[];

        if (broadcast === "full") {
          changed = next;
        } else if (changedIds) {
          const wanted = new Set(changedIds);
          changed = next.filter((element) => wanted.has(element.id));
        } else {
          // Fall back to structural diffing when the caller did not say which
          // elements it touched. Indexed, so this stays linear.
          const before = new Map(
            previous.map((element) => [element.id, element.version]),
          );
          changed = next.filter(
            (element) => before.get(element.id) !== element.version,
          );
        }

        let removed: string[];

        if (deletedIds.length > 0) {
          removed = [...deletedIds];
        } else if (next.length < previous.length) {
          const surviving = new Set(next.map((element) => element.id));
          removed = previous
            .filter((element) => !surviving.has(element.id))
            .map((element) => element.id);
        } else {
          removed = [];
        }

        emit({ elements: next, changed, deletedIds: removed, mode: broadcast });
      }

      return next;
    },
    [commit, write],
  );

  const restore = useCallback(
    (index: number) => {
      const snapshot = historyRef.current[index];
      if (!snapshot) {
        return;
      }

      historyIndexRef.current = index;
      write(snapshot);
      setHistoryVersion((version) => version + 1);

      onChangeRef.current?.({
        elements: snapshot,
        changed: snapshot,
        deletedIds: [],
        mode: "full",
      });
    },
    [write],
  );

  const undo = useCallback(() => {
    if (historyIndexRef.current > 0) {
      restore(historyIndexRef.current - 1);
    }
  }, [restore]);

  const redo = useCallback(() => {
    if (historyIndexRef.current < historyRef.current.length - 1) {
      restore(historyIndexRef.current + 1);
    }
  }, [restore]);

  const resetHistory = useCallback(
    (nextElements: Shape[]) => {
      historyRef.current = [nextElements];
      historyIndexRef.current = 0;
      write(nextElements);
      setHistoryVersion((version) => version + 1);
    },
    [write],
  );

  const { canUndo, canRedo } = useMemo(
    () => ({
      canUndo: historyIndexRef.current > 0,
      canRedo: historyIndexRef.current < historyRef.current.length - 1,
    }),
    // historyVersion is the signal that the stack moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historyVersion],
  );

  return {
    elements,
    elementsRef,
    applyElements,
    commit,
    undo,
    redo,
    canUndo,
    canRedo,
    resetHistory,
  };
};

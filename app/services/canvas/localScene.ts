/**
 * Local scene storage — the persistence tier that needs no account.
 *
 * This mirrors what excalidraw.com does. Opening it drops you straight onto the
 * canvas you were last drawing on, with no sign-in and no "create a board"
 * step, because the scene lives in localStorage: elements under `excalidraw`,
 * app state under `excalidraw-state`, written on a 300ms debounce, and paused
 * while you are inside a collaboration room (where the server owns the scene
 * instead). The same three decisions are made here — see
 * `useLocalSceneAutosave` for the debounce and the pause.
 *
 * Differences worth naming: the elements and the viewport go under one
 * versioned key rather than two bare ones, so a future format change can be
 * detected instead of guessed at; and reads go through `restoreElements`, so a
 * hand-edited or truncated entry yields a valid scene rather than throwing.
 */
import { restoreElements } from "./elements";
import type { Shape, Viewport } from "../../types/shapes";

/** Single versioned entry holding the last local scene. */
export const LOCAL_SCENE_KEY = "collabdraw_scene";

/** Matches Excalidraw's `SAVE_TO_LOCAL_STORAGE_TIMEOUT`. */
export const SAVE_DEBOUNCE_MS = 300;

/** Current payload version; bump when the stored shape changes. */
export const LOCAL_SCENE_VERSION = 1;

export interface LocalScene {
  elements: Shape[];
  viewport: Viewport | null;
  /** When the entry was written, or null when there was nothing to read. */
  savedAt: number | null;
}

const EMPTY: LocalScene = { elements: [], viewport: null, savedAt: null };

const isViewport = (value: unknown): value is Viewport => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { zoom?: unknown; scroll?: unknown };
  if (typeof candidate.zoom !== "number" || !Number.isFinite(candidate.zoom)) {
    return false;
  }
  const scroll = candidate.scroll as { x?: unknown; y?: unknown } | undefined;
  return (
    typeof scroll === "object" &&
    scroll !== null &&
    typeof scroll.x === "number" &&
    Number.isFinite(scroll.x) &&
    typeof scroll.y === "number" &&
    Number.isFinite(scroll.y)
  );
};

/**
 * Read the stored scene. Never throws: a missing, unparseable, or
 * wrong-version entry reads as an empty scene, and so does a browser that
 * refuses storage (private windows, cookies blocked).
 */
export function loadLocalScene(): LocalScene {
  if (typeof window === "undefined") {
    return EMPTY;
  }

  let raw: string | null;
  try {
    raw = window.localStorage.getItem(LOCAL_SCENE_KEY);
  } catch {
    return EMPTY;
  }
  if (!raw) {
    return EMPTY;
  }

  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      elements?: unknown;
      viewport?: unknown;
      savedAt?: unknown;
    };

    if (parsed?.version !== LOCAL_SCENE_VERSION) {
      return EMPTY;
    }

    return {
      elements: restoreElements(parsed.elements),
      viewport: isViewport(parsed.viewport) ? parsed.viewport : null,
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : null,
    };
  } catch {
    return EMPTY;
  }
}

/**
 * Write the scene. Returns false when storage rejected it — a full quota is
 * the realistic case, and the caller should not treat that as fatal.
 */
export function saveLocalScene(
  elements: readonly Shape[],
  viewport: Viewport | null,
): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    window.localStorage.setItem(
      LOCAL_SCENE_KEY,
      JSON.stringify({
        version: LOCAL_SCENE_VERSION,
        elements,
        viewport,
        savedAt: Date.now(),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Forget the local scene (used by "Reset canvas"). */
export function clearLocalScene(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(LOCAL_SCENE_KEY);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

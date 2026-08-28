/**
 * Scene files — "Save to file" / "Open file" in the main menu.
 *
 * The shape follows Excalidraw's `.excalidraw` document (a `type` tag, a
 * `version`, a `source`, then the elements) so the file is self-describing and
 * a future reader can tell what it is holding. Parsing is deliberately lenient
 * about everything except the type tag: elements go through `restoreElements`,
 * so a file written by an older build still opens.
 */
import { restoreElements } from "./elements";
import type { Shape, Viewport } from "../../types/shapes";

export const SCENE_FILE_TYPE = "collabdraw";
export const SCENE_FILE_VERSION = 1;
export const SCENE_FILE_EXTENSION = ".collabdraw";
export const SCENE_FILE_MIME = "application/json";

export interface SceneFile {
  elements: Shape[];
  viewport: Viewport | null;
}

export function serializeScene(
  elements: readonly Shape[],
  viewport: Viewport | null,
  source = "collabdraw",
): string {
  return JSON.stringify(
    {
      type: SCENE_FILE_TYPE,
      version: SCENE_FILE_VERSION,
      source,
      elements,
      viewport,
    },
    null,
    2,
  );
}

/**
 * Parse a scene file. Returns null when the text is not JSON or is not a
 * CollabDraw document, so the caller can tell "wrong file" from "empty scene" —
 * a file that legitimately contains no elements parses to an empty array.
 */
export function parseSceneFile(text: string): SceneFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const document = parsed as {
    type?: unknown;
    elements?: unknown;
    viewport?: unknown;
  };

  if (document.type !== SCENE_FILE_TYPE) {
    return null;
  }

  const viewport = document.viewport as Viewport | undefined;
  const hasViewport =
    typeof viewport === "object" &&
    viewport !== null &&
    typeof viewport.zoom === "number" &&
    Number.isFinite(viewport.zoom) &&
    typeof viewport.scroll?.x === "number" &&
    typeof viewport.scroll?.y === "number";

  return {
    elements: restoreElements(document.elements),
    viewport: hasViewport ? viewport : null,
  };
}

/** `collabdraw-2026-08-28.collabdraw` */
export function sceneFileName(date = new Date()): string {
  return `collabdraw-${date.toISOString().slice(0, 10)}${SCENE_FILE_EXTENSION}`;
}

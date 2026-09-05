/**
 * Editor preferences — the pen you were last drawing with.
 *
 * Kept in their own localStorage key, deliberately not in `collabdraw_scene`:
 * scene saving is paused inside a collaboration room (the server owns the scene
 * there), and a colour picked in a room should still be the colour you have
 * afterwards. Excalidraw splits them the same way, `excalidraw-state` beside
 * `excalidraw`, and persists the `currentItem*` family for exactly this reason.
 * Theme is the third of these keys and predates this file (`useTheme`).
 *
 * Reads never throw and never reject the whole entry over one bad field: each is
 * validated on its own and falls back to its default, so a hand-edited or
 * half-written entry costs you one setting rather than all of them.
 */
import {
  DEFAULT_STYLE,
  type EdgeStyle,
  type ElementStyle,
  type FillStyle,
  type StrokeStyle,
} from "../../types/shapes";

export const PREFERENCES_KEY = "collabdraw_preferences";

/** Current payload version; bump when the stored shape changes. */
export const PREFERENCES_VERSION = 1;

export interface EditorPreferences {
  /** Defaults for new elements, and what the style panel edits. */
  style: ElementStyle;
  /**
   * Whether the chosen tool stays chosen after drawing. On by default: snapping
   * back to selection is a surprise when you are drawing several of the same
   * thing. Toggled with Q.
   */
  toolLocked: boolean;
}

export const DEFAULT_PREFERENCES: EditorPreferences = {
  style: DEFAULT_STYLE,
  toolLocked: true,
};

/*
 * The string unions, as values. Written as records keyed by the union so that
 * adding a member to `FillStyle` and forgetting it here is a type error rather
 * than a setting that silently resets itself.
 */
const FILL_STYLES: Record<FillStyle, true> = {
  solid: true,
  hachure: true,
  zigzag: true,
  "cross-hatch": true,
  dots: true,
  dashed: true,
  "zigzag-line": true,
};

const STROKE_STYLES: Record<StrokeStyle, true> = {
  solid: true,
  dashed: true,
  dotted: true,
};

const EDGE_STYLES: Record<EdgeStyle, true> = {
  straight: true,
  curved: true,
  elbow: true,
};

/** `Object.hasOwn`, not `in`: `"toString" in record` is true for any object. */
const isOneOf = <T extends string>(
  value: unknown,
  allowed: Record<T, true>,
): value is T => typeof value === "string" && Object.hasOwn(allowed, value);

/**
 * Numbers are clamped to a renderable range rather than matched against the
 * panel's presets. A stored width of 3 is not a value any button produces, but
 * it draws perfectly well, and a future control might offer it.
 */
const clamped = (
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
};

/**
 * Colours are length-capped strings, not parsed. Anything CSS accepts is fine
 * here and an unparseable one is cosmetic — it reaches a canvas context and an
 * `<input type="color">`, never markup — but a megabyte of it should not reach
 * the render path.
 */
const capped = (value: unknown, limit: number, fallback: string): string =>
  typeof value === "string" && value.length > 0 && value.length <= limit
    ? value
    : fallback;

const restoreStyle = (value: unknown): ElementStyle => {
  const raw = (
    typeof value === "object" && value !== null ? value : {}
  ) as Record<string, unknown>;

  return {
    stroke: capped(raw.stroke, 64, DEFAULT_STYLE.stroke),
    fill: capped(raw.fill, 64, DEFAULT_STYLE.fill),
    fillStyle: isOneOf(raw.fillStyle, FILL_STYLES)
      ? raw.fillStyle
      : DEFAULT_STYLE.fillStyle,
    strokeWidth: clamped(raw.strokeWidth, 0.5, 100, DEFAULT_STYLE.strokeWidth),
    strokeStyle: isOneOf(raw.strokeStyle, STROKE_STYLES)
      ? raw.strokeStyle
      : DEFAULT_STYLE.strokeStyle,
    roughness: clamped(raw.roughness, 0, 2, DEFAULT_STYLE.roughness),
    opacity: clamped(raw.opacity, 10, 100, DEFAULT_STYLE.opacity),
    fontSize: clamped(raw.fontSize, 8, 200, DEFAULT_STYLE.fontSize),
    fontFamily: capped(raw.fontFamily, 200, DEFAULT_STYLE.fontFamily),
    edgeStyle: isOneOf(raw.edgeStyle, EDGE_STYLES)
      ? raw.edgeStyle
      : DEFAULT_STYLE.edgeStyle,
  };
};

/**
 * Read the stored preferences. Never throws: a missing, unparseable or
 * wrong-version entry reads as the defaults, and so does a browser that refuses
 * storage (private windows, cookies blocked).
 */
export function readPreferences(): EditorPreferences {
  if (typeof window === "undefined") {
    return DEFAULT_PREFERENCES;
  }

  let raw: string | null;
  try {
    raw = window.localStorage.getItem(PREFERENCES_KEY);
  } catch {
    return DEFAULT_PREFERENCES;
  }
  if (!raw) {
    return DEFAULT_PREFERENCES;
  }

  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      style?: unknown;
      toolLocked?: unknown;
    };

    if (parsed?.version !== PREFERENCES_VERSION) {
      return DEFAULT_PREFERENCES;
    }

    return {
      style: restoreStyle(parsed.style),
      toolLocked:
        typeof parsed.toolLocked === "boolean"
          ? parsed.toolLocked
          : DEFAULT_PREFERENCES.toolLocked,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

/**
 * Persist the preferences. Returns false when storage refused the write, which
 * only means the choice does not outlive the session — never worth interrupting
 * anyone over, unlike a scene that failed to save.
 */
export function writePreferences(preferences: EditorPreferences): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    window.localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ version: PREFERENCES_VERSION, ...preferences }),
    );
    return true;
  } catch {
    return false;
  }
}

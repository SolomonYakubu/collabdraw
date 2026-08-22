/**
 * Free-placement scenes: anything that is neither a graph nor a grid.
 *
 * Positions are given on a normalised 0-100 canvas rather than in pixels. That
 * keeps the one property that made the diagram path reliable — the model is
 * never asked for absolute coordinates it cannot reason about — while still
 * allowing arbitrary compositions. Everything is clamped, so a confused reply
 * produces a squashed drawing rather than shapes scattered off-screen.
 */
import { ACCENT_COLORS, type NodeAccent } from "./graph";

export type SceneShape =
  | "rectangle"
  | "ellipse"
  | "diamond"
  | "triangle"
  | "line"
  | "arrow"
  | "text";

export const SCENE_SHAPES: SceneShape[] = [
  "rectangle",
  "ellipse",
  "diamond",
  "triangle",
  "line",
  "arrow",
  "text",
];

export interface SceneItem {
  shape: SceneShape;
  /** Normalised 0-100. For a line or arrow, the start point. */
  x: number;
  y: number;
  /** Normalised 0-100 extent. Unused by lines and arrows. */
  width: number;
  height: number;
  /** Normalised 0-100 end point, for lines and arrows. */
  x2: number;
  y2: number;
  text: string;
  accent: NodeAccent;
  filled: boolean;
  /** Clockwise rotation in degrees, about the shape's own centre. */
  rotation: number;
}

export interface SceneSpec {
  items: SceneItem[];
}

export const MAX_SCENE_ITEMS = 60;

/** Anything smaller than this on the normalised canvas is invisible. */
const MIN_EXTENT = 1;

const asNumber = (value: unknown): number | null => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

  return Number.isFinite(parsed) ? parsed : null;
};

const clamp01to100 = (value: unknown, fallback: number): number => {
  const parsed = asNumber(value);
  if (parsed === null) {
    return fallback;
  }
  return Math.min(100, Math.max(0, parsed));
};

const asShape = (value: unknown): SceneShape | null =>
  SCENE_SHAPES.includes(value as SceneShape) ? (value as SceneShape) : null;

const asAccent = (value: unknown): NodeAccent =>
  value && typeof value === "string" && value in ACCENT_COLORS
    ? (value as NodeAccent)
    : "none";

/**
 * Validate a scene. Returns `null` when nothing usable is present, so the caller
 * can fall back to another intent.
 */
export const parseSceneSpec = (input: unknown): SceneSpec | null => {
  if (!input || typeof input !== "object") {
    return null;
  }

  const raw = input as Record<string, unknown>;
  const rawItems = Array.isArray(raw.items) ? raw.items : [];

  const items: SceneItem[] = [];

  for (const candidate of rawItems) {
    if (items.length >= MAX_SCENE_ITEMS || !candidate || typeof candidate !== "object") {
      continue;
    }

    const item = candidate as Record<string, unknown>;
    const shape = asShape(item.shape);

    if (!shape) {
      continue;
    }

    const text = String(item.text ?? "").replace(/\s+/g, " ").trim().slice(0, 80);

    // A text item with nothing to say is not worth placing.
    if (shape === "text" && !text) {
      continue;
    }

    const x = clamp01to100(item.x, 0);
    const y = clamp01to100(item.y, 0);
    const isLinear = shape === "line" || shape === "arrow";

    const width = isLinear
      ? 0
      : Math.max(MIN_EXTENT, clamp01to100(item.width, 10));
    const height = isLinear
      ? 0
      : Math.max(MIN_EXTENT, clamp01to100(item.height, 10));

    // A line needs a distinct end point; default to a short horizontal run so a
    // missing one does not collapse it to nothing.
    const x2 = isLinear ? clamp01to100(item.x2, Math.min(100, x + 10)) : 0;
    const y2 = isLinear ? clamp01to100(item.y2, y) : 0;

    if (isLinear && Math.abs(x2 - x) < 0.01 && Math.abs(y2 - y) < 0.01) {
      continue;
    }

    // Rotation is wrapped rather than clamped: -90 and 270 mean the same thing.
    const rotationValue = asNumber(item.rotation);
    const rotation =
      rotationValue === null ? 0 : ((rotationValue % 360) + 360) % 360;

    items.push({
      shape,
      x,
      y,
      width,
      height,
      x2,
      y2,
      text,
      accent: asAccent(item.accent),
      filled: item.filled === true,
      rotation,
    });
  }

  return items.length > 0 ? { items } : null;
};

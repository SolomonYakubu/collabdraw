/**
 * Grids: boards, tables, calendars, matrices.
 *
 * A tic-tac-toe board is not a block diagram, but it is not freeform either —
 * it is three columns by three rows. Describing it as rows and columns means the
 * lines are always exactly aligned and evenly spaced, which is the one thing a
 * model placing individual lines would reliably get slightly wrong.
 */
import { ACCENT_COLORS, type NodeAccent } from "./graph";

/**
 * `board` draws only the separators between cells — a tic-tac-toe grid is four
 * lines, with no box around the outside. `table` gives every cell its own
 * outline, so it reads as a table and each cell can be edited.
 */
export type GridStyle = "board" | "table";

export interface GridCell {
  row: number;
  column: number;
  text: string;
  accent: NodeAccent;
}

export interface GridSpec {
  rows: number;
  columns: number;
  style: GridStyle;
  /** Emphasise the first row, for a table with column headings. */
  headerRow: boolean;
  cells: GridCell[];
}

export const MAX_GRID_SIDE = 16;
const MAX_CELLS = MAX_GRID_SIDE * MAX_GRID_SIDE;

const asInt = (value: unknown): number | null => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

  return Number.isFinite(parsed) ? Math.round(parsed) : null;
};

const clampSide = (value: unknown): number | null => {
  const parsed = asInt(value);
  if (parsed === null || parsed < 1) {
    return null;
  }
  return Math.min(parsed, MAX_GRID_SIDE);
};

const asAccent = (value: unknown): NodeAccent =>
  value && typeof value === "string" && value in ACCENT_COLORS
    ? (value as NodeAccent)
    : "none";

/**
 * Validate a grid description. Returns `null` when there is no usable grid, so
 * the caller can fall back to another intent.
 */
export const parseGridSpec = (input: unknown): GridSpec | null => {
  if (!input || typeof input !== "object") {
    return null;
  }

  const raw = input as Record<string, unknown>;

  const rows = clampSide(raw.rows);
  const columns = clampSide(raw.columns);

  // A single cell is not a grid; that is just a rectangle.
  if (rows === null || columns === null || rows * columns < 2) {
    return null;
  }

  const style: GridStyle = raw.style === "table" ? "table" : "board";
  const rawCells = Array.isArray(raw.cells) ? raw.cells : [];

  const cells: GridCell[] = [];
  const occupied = new Set<string>();

  for (const candidate of rawCells) {
    if (cells.length >= MAX_CELLS || !candidate || typeof candidate !== "object") {
      continue;
    }

    const cell = candidate as Record<string, unknown>;
    const row = asInt(cell.row);
    const column = asInt(cell.column);

    // Accept both 0-based and 1-based indices: models mix them freely, and a
    // grid is small enough that the intent is unambiguous either way.
    const normalisedRow = row === null ? null : row >= rows ? row - 1 : row;
    const normalisedColumn =
      column === null ? null : column >= columns ? column - 1 : column;

    if (
      normalisedRow === null ||
      normalisedColumn === null ||
      normalisedRow < 0 ||
      normalisedColumn < 0 ||
      normalisedRow >= rows ||
      normalisedColumn >= columns
    ) {
      continue;
    }

    const key = `${normalisedRow}:${normalisedColumn}`;
    if (occupied.has(key)) {
      continue;
    }
    occupied.add(key);

    cells.push({
      row: normalisedRow,
      column: normalisedColumn,
      text: String(cell.text ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
      accent: asAccent(cell.accent),
    });
  }

  return {
    rows,
    columns,
    style,
    headerRow: raw.headerRow === true,
    cells,
  };
};

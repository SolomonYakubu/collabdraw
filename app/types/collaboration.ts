/**
 * Collaboration types.
 */

/** A connected participant. */
export interface User {
  id: string;
  tag: string;
}

/** A remote cursor, in world coordinates. */
export interface CursorPosition {
  x: number;
  y: number;
  tag?: string;
  /** Timestamp of the last update, used to expire idle cursors. */
  updatedAt?: number;
}

export type CursorPositionsMap = Record<string, CursorPosition>;

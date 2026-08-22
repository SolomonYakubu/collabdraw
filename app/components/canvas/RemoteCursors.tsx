"use client";

/**
 * Remote collaborator cursors.
 *
 * Positions arrive in world coordinates and are projected through the same
 * viewport transform the canvas uses, so a cursor lands on the same point of
 * the drawing for everyone regardless of each person's zoom or scroll. The two
 * previous overlays disagreed about this: one treated the coordinates as
 * client-space, the other multiplied them by the local zoom only.
 */
import { memo } from "react";
import type { CursorPositionsMap } from "../../types/collaboration";
import type { Viewport } from "../../types/shapes";
import { worldToScreen } from "../../utils/viewport";

interface RemoteCursorsProps {
  cursors: CursorPositionsMap;
  currentUserId: string | null;
  viewport: Viewport;
}

/** Stable per-user colour, so the same person keeps the same colour. */
const COLORS = [
  "#e03131",
  "#2f9e44",
  "#1971c2",
  "#f08c00",
  "#9c36b5",
  "#0c8599",
  "#e8590c",
];

const colorFor = (userId: string): string => {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return COLORS[Math.abs(hash) % COLORS.length];
};

const RemoteCursors: React.FC<RemoteCursorsProps> = ({
  cursors,
  currentUserId,
  viewport,
}) => (
  <div className="pointer-events-none absolute inset-0 overflow-hidden">
    {Object.entries(cursors).map(([userId, cursor]) => {
      if (userId === currentUserId) {
        return null;
      }

      const { x, y } = worldToScreen(cursor.x, cursor.y, viewport);
      const color = colorFor(userId);

      return (
        <div
          key={userId}
          className="absolute left-0 top-0 will-change-transform"
          style={{
            transform: `translate3d(${x}px, ${y}px, 0)`,
            transition: "transform 80ms linear",
          }}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
            <path
              d="M2 2 L2 15 L6 11.5 L8.5 17 L11 16 L8.5 10.5 L14 10.5 Z"
              fill={color}
              stroke="#ffffff"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
          {cursor.tag && (
            <span
              className="absolute left-4 top-4 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium text-white shadow-sm"
              style={{ backgroundColor: color }}
            >
              {cursor.tag}
            </span>
          )}
        </div>
      );
    })}
  </div>
);

export default memo(RemoteCursors);

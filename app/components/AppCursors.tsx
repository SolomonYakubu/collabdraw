"use client";

import React, { useEffect, useState } from "react";
import { CursorPositionsMap } from "../types/collaboration";

interface AppCursorsProps {
  cursors: CursorPositionsMap;
  currentUserId: string | null;
}

/**
 * Global application cursor overlay that works at the document level
 * instead of being constrained to the canvas
 */
const AppCursors: React.FC<AppCursorsProps> = ({ cursors, currentUserId }) => {
  const [mounted, setMounted] = useState(false);

  // Only render on client side
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <div
      className="fixed inset-0 pointer-events-none z-[9999] overflow-hidden"
      style={{ pointerEvents: "none" }}
    >
      {Object.entries(cursors).map(([userId, cursor]) => {
        // Skip our own cursor
        if (userId === currentUserId) return null;

        if (
          !cursor ||
          typeof cursor.x !== "number" ||
          typeof cursor.y !== "number"
        )
          return null;

        return (
          <div
            key={userId}
            className="absolute"
            style={{
              left: cursor.x,
              top: cursor.y,
              transform: "translate(0, 0)",
              transition: "left 0.1s ease-out, top 0.1s ease-out",
              pointerEvents: "none",
              zIndex: 10000,
            }}
          >
            {/* Cursor arrow */}
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M3 3L10.07 19.97L12.58 12.58L19.97 10.07L3 3Z"
                fill="#2563EB"
                stroke="#FFFFFF"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>

            {/* User tag with background */}
            <div className="absolute left-6 top-0 px-2 py-1 text-xs font-bold text-white rounded bg-blue-600 whitespace-nowrap shadow-md">
              {cursor.tag || "User"}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default AppCursors;

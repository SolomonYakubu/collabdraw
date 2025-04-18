"use client";

import React, { memo } from "react";
import { CursorPositionsMap } from "../../types/collaboration";

interface CollaborationCursorsProps {
  cursors: CursorPositionsMap;
  currentUserId: string | null;
  zoom?: number;
  panOffset?: { x: number; y: number };
  isInfiniteCanvas?: boolean;
}

const CollaborationCursors = memo(
  ({
    cursors,
    currentUserId,
    zoom = 1,
    panOffset = { x: 0, y: 0 },
    isInfiniteCanvas = false,
  }: CollaborationCursorsProps) => {
    if (!cursors || Object.keys(cursors).length === 0) return null;

    return (
      <div
        className="collaboration-cursors"
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          zIndex: 1000,
        }}
      >
        {Object.entries(cursors).map(([userId, position]) => {
          // Don't render cursor for the current user
          if (userId === currentUserId) return null;

          // Check if position is valid to prevent rendering errors
          if (!position || position.x === undefined || position.y === undefined)
            return null;

          // Apply zoom and pan transformations to cursor coordinates if using infinite canvas
          const cursorX = isInfiniteCanvas
            ? position.x * zoom + panOffset.x
            : position.x;

          const cursorY = isInfiniteCanvas
            ? position.y * zoom + panOffset.y
            : position.y;

          // Generate a unique color for each user based on their ID
          const userColor = getUserColor(userId);

          const cursorStyle = {
            position: "absolute" as const,
            left: cursorX,
            top: cursorY,
            pointerEvents: "none" as const,
            zIndex: 9999,
            transform: "translate(-3px, -3px)",
            transition: "left 0.05s ease, top 0.05s ease",
          };

          const tooltipStyle = {
            position: "absolute" as const,
            left: 12,
            top: 12,
            backgroundColor: userColor,
            color: "white",
            padding: "2px 6px",
            borderRadius: "4px",
            fontSize: "12px",
            pointerEvents: "none" as const,
            whiteSpace: "nowrap" as const,
            textOverflow: "ellipsis",
            overflow: "hidden",
            maxWidth: "120px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          };

          return (
            <div key={userId} style={cursorStyle}>
              <svg
                width="20"
                height="20"
                viewBox="0 0 16 16"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M0.5 0.5L6.5 15.5L8.5 8.5L15.5 6.5L0.5 0.5Z"
                  fill="white"
                  stroke={userColor}
                  strokeWidth="1.5"
                />
              </svg>
              <div style={tooltipStyle}>{position.tag || "User"}</div>
            </div>
          );
        })}
      </div>
    );
  }
);

// Helper function to generate a consistent color for each user based on their ID
function getUserColor(userId: string): string {
  // Create a simple hash from the userId
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }

  // Convert to a vibrant color (avoiding too dark or too light colors)
  const hue = hash % 360;
  return `hsl(${hue}, 75%, 50%)`;
}

CollaborationCursors.displayName = "CollaborationCursors";
export default CollaborationCursors;

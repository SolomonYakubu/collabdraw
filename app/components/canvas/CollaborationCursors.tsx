"use client";

import React, { memo } from "react";
import { CursorPositionsMap } from "../../types/collaboration";
import { FiCursor } from "react-icons/fi";

interface CollaborationCursorsProps {
  cursors: CursorPositionsMap;
  currentUserId: string | null;
  zoom?: number;
  panOffset?: { x: number; y: number };
  isInfiniteCanvas?: boolean;
}

const CollaborationCursors: React.FC<CollaborationCursorsProps> = ({
  cursors,
  currentUserId,
  zoom = 1,
  panOffset = { x: 0, y: 0 },
  isInfiniteCanvas = false,
}) => {
  // Transform cursor coordinates from world space to screen space
  const transformCursor = (x: number, y: number) => {
    if (!isInfiniteCanvas) return { x, y };
    
    // Apply the same transform as the canvas uses
    return {
      x: x * zoom, 
      y: y * zoom
    };
  };

  return (
    <>
      {Object.entries(cursors).map(([userId, cursor]) => {
        if (userId === currentUserId || !cursor) return null;
        
        // Convert from world coordinates to screen coordinates
        const { x, y } = transformCursor(cursor.x, cursor.y);
        
        return (
          <div
            key={userId}
            className="absolute pointer-events-none z-50 flex flex-col items-start"
            style={{
              transform: `translate(${x}px, ${y}px)`,
              transition: "transform 0.1s ease-out",
            }}
          >
            {/* Scale the cursor inversely to the zoom to keep its size consistent */}
            <div style={{ transform: `scale(${1/zoom})`, transformOrigin: 'top left' }}>
              <FiCursor
                size={20}
                className="text-blue-500 -ml-1 -mt-1 transform -rotate-90"
              />
              {cursor.tag && (
                <span className="ml-4 px-2 py-1 bg-blue-500 text-white text-xs rounded-md whitespace-nowrap">
                  {cursor.tag}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
};

export default CollaborationCursors;

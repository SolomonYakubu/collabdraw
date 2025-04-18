/**
 * Types for collaboration features
 */

import { Shape } from "./shapes";

// Augment Window interface to include our timer property
declare global {
  interface Window {
    __cursorUpdateTimer: number | null;
  }
}

// Information about a connected user
export interface User {
  id: string;
  tag: string;
}

// Active users map
export interface ActiveUsersMap {
  [userId: string]: User;
}

// Cursor position data for a specific user
export interface CursorPosition {
  x: number;
  y: number;
  tag?: string;
}

// Map of user IDs to cursor positions
export type CursorPositionsMap = Record<string, CursorPosition>;

// Drawing state information
export interface DrawingState {
  userId: string;
  isDrawing: boolean;
}

// Canvas update event data
export interface CanvasUpdateEvent {
  roomId: string;
  userId: string;
  shapes: SerializedShape[];
  isPartial?: boolean; // Flag to indicate partial updates (e.g. dragging)
}

// Cursor update event data
export interface CursorUpdateEvent {
  roomId: string;
  userId: string;
  userTag: string;
  x: number;
  y: number;
}

// Socket event callbacks
export interface SocketCallbacks {
  onCursorUpdate?: (cursors: CursorPositionsMap) => void;
  onUsersUpdate?: (users: User[]) => void;
  onCanvasUpdate?: (shapes: Shape[]) => void;
  onDrawingStateChange?: (userId: string, isDrawing: boolean) => void;
  onCanvasStateRequest?: (targetUserId: string) => void;
}

// Socket service configuration
export interface SocketServiceConfig {
  serverUrl: string;
  roomId: string;
  userId: string;
  userTag: string;
}

// Collaboration context state
export interface CollaborationState {
  isConnected: boolean;
  roomId: string | null;
  userId: string;
  userTag: string;
  users: User[];
  cursors: CursorPositionsMap;
  shareableLink: string;
}

// Collaboration context actions
export interface CollaborationActions {
  broadcastCanvasData: (shapes: Shape[]) => void;
  broadcastShapeUpdate: (shape: Shape) => void; // Add this new action
  broadcastCursorPosition: (x: number, y: number) => void;
  broadcastDrawingState: (isDrawing: boolean) => void;
  generateShareableLink: () => string;
  disconnectSocket: () => void;
}
export interface SerializedShape {}

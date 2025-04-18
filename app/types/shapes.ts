/**
 * Types for all canvas shapes and their properties
 */

// Common shape type used throughout the application
export type ShapeType =
  | "Freehand"
  | "Line"
  | "Square"
  | "Circle"
  | "Diamond"
  | "Text"
  | "Select"
  | "Arrow"
  | "Eraser"
  | "Pan"
  | "Group"; // Added Group type

// Rough.js options for sketchy drawing style
export interface RoughOptions {
  seed?: number;
  fillStyle?:
    | "solid"
    | "hachure"
    | "zigzag"
    | "cross-hatch"
    | "dots"
    | "dashed"
    | "zigzag-line";
  strokeWidth?: number;
  roughness?: number; // 0 to 5
  bowing?: number; // 0 to 5
  curveFitting?: number; // 0 to 1
  simplification?: number; // 0 to 1
}

// Basic shape interface with common properties
export interface BaseShape {
  id: string | number;
  tool: ShapeType;
  x: number;
  y: number;
  width?: number;
  height?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  points: number[];
  stroke: string;
  strokeWidth: number;
  fill: string;
  roughOptions?: RoughOptions;
  selected?: boolean;
  opacity?: number;
  userId?: string;

  isInProgress?: boolean;
}

// Freehand drawing shape
export interface FreehandShape extends BaseShape {
  tool: "Freehand";
  points: number[];
  simplifyTolerance?: number;
}

// Line shape
export interface LineShape extends BaseShape {
  tool: "Line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// Arrow shape
export interface ArrowShape extends BaseShape {
  tool: "Arrow";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  arrowSize?: number;
}

// Square/Rectangle shape
export interface SquareShape extends BaseShape {
  tool: "Square";
  width: number;
  height: number;
}

// Circle shape
export interface CircleShape extends BaseShape {
  tool: "Circle";
  width: number;
  height: number;
}

// Diamond shape
export interface DiamondShape extends BaseShape {
  tool: "Diamond";
  width: number;
  height: number;
}

// Text shape
export interface TextShape extends BaseShape {
  tool: "Text";
  x: number;
  y: number;
  text: string;
  fontSize?: number;
  fontFamily?: string;
  fill: string;
  width?: number;
  height?: number;
  isEditing?: boolean;
  cursorPosition?: {
    line: number;
    offset: number;
  };
  selection?: {
    start: {
      line: number;
      offset: number;
    };
    end: {
      line: number;
      offset: number;
    };
  };
}

// Group shape for combining multiple shapes
export interface GroupShape extends BaseShape {
  tool: "Group";
  childIds: (string | number)[]; // IDs of shapes in this group
  width: number;
  height: number;
}

// Union type of all possible shapes
export type Shape =
  | FreehandShape
  | LineShape
  | SquareShape
  | CircleShape
  | DiamondShape
  | TextShape
  | ArrowShape
  | GroupShape;

// Element type for selection
export interface ElementOffset {
  x: number;
  y: number;
}

// Bounding box for selection, drag operations
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Props for shape components
export interface ShapeComponentProps {
  shape: Shape;
  isSelected: boolean;
  onSelect: (id: string | number) => void;
  isSelectionMode: boolean;
}

// Shape factory type
export type ShapeFactory = (type: ShapeType, attrs: any) => Shape;

// Shape serialization helpers
export interface SerializedShape {
  attrs: any;
  className: string;
}

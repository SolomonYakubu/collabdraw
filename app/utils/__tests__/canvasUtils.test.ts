/**
 * Tests for canvas utility functions
 */
import { describe, it, expect, vi } from "vitest";
import {
  getResizeHandleAtPosition,
  calculateNewBounds,
  updateShapeBounds,
  moveShape,
} from "../../utils/canvasUtils";
import { Shape, BoundingBox } from "../../types/shapes";

describe("Canvas Utils", () => {
  // Mock shape for testing
  const mockSquareShape: Shape = {
    id: "square1",
    tool: "Square",
    x: 10,
    y: 20,
    width: 100,
    height: 80,
    points: [],
    stroke: "#000000",
    strokeWidth: 2,
    fill: "transparent",
  };

  const mockLineShape: Shape = {
    id: "line1",
    tool: "Line",
    x: 10,
    y: 20,
    x1: 10,
    y1: 20,
    x2: 110,
    y2: 100,
    points: [],
    stroke: "#000000",
    strokeWidth: 2,
    fill: "transparent",
  };

  const mockTextShape: Shape = {
    id: "text1",
    tool: "Text",
    x: 10,
    y: 20,
    width: 100,
    height: 30,
    text: "Test Text",
    fontSize: 16,
    fontFamily: "Arial",
    fill: "#000000",
    points: [],
    stroke: "#000000",
    strokeWidth: 1,
  };

  describe("getResizeHandleAtPosition", () => {
    const bounds: BoundingBox = { x: 10, y: 20, width: 100, height: 80 };

    it("should detect top-left handle", () => {
      expect(getResizeHandleAtPosition(10, 20, bounds)).toBe("top-left");
    });

    it("should detect top-center handle", () => {
      expect(getResizeHandleAtPosition(60, 20, bounds)).toBe("top-center");
    });

    it("should detect bottom-right handle", () => {
      expect(getResizeHandleAtPosition(110, 100, bounds)).toBe("bottom-right");
    });

    it("should return null when not on a handle", () => {
      expect(getResizeHandleAtPosition(50, 50, bounds)).toBeNull();
    });
  });

  describe("calculateNewBounds", () => {
    const initialBounds: BoundingBox = { x: 10, y: 20, width: 100, height: 80 };

    it("should calculate new bounds for top-left resize", () => {
      const newBounds = calculateNewBounds(5, 15, initialBounds, "top-left");
      expect(newBounds).toEqual({
        x: 5,
        y: 15,
        width: 105,
        height: 85,
      });
    });

    it("should calculate new bounds for bottom-right resize", () => {
      const newBounds = calculateNewBounds(
        120,
        110,
        initialBounds,
        "bottom-right"
      );
      expect(newBounds).toEqual({
        x: 10,
        y: 20,
        width: 110,
        height: 90,
      });
    });

    it("should enforce minimum size during resize", () => {
      const newBounds = calculateNewBounds(200, 200, initialBounds, "top-left");
      expect(newBounds?.width).toBeGreaterThanOrEqual(5);
      expect(newBounds?.height).toBeGreaterThanOrEqual(5);
    });
  });

  describe("updateShapeBounds", () => {
    it("should update square shape bounds", () => {
      const newBounds: BoundingBox = { x: 20, y: 30, width: 120, height: 90 };
      const updated = updateShapeBounds(mockSquareShape, newBounds);

      expect(updated).toEqual({
        ...mockSquareShape,
        x: 20,
        y: 30,
        width: 120,
        height: 90,
      });
    });

    it("should update line shape bounds", () => {
      const newBounds: BoundingBox = { x: 20, y: 30, width: 120, height: 90 };

      // Mock getShapeBoundingBox since we're not importing it from drawingService
      vi.mock("../../services/canvas/drawingService", () => ({
        getShapeBoundingBox: () => ({ x: 10, y: 20, width: 100, height: 80 }),
      }));

      const updated = updateShapeBounds(mockLineShape, newBounds);

      expect(updated.x).toBe(20);
      expect(updated.y).toBe(30);
      expect(updated.x1).not.toBe(mockLineShape.x1);
      expect(updated.y1).not.toBe(mockLineShape.y1);
      expect(updated.x2).not.toBe(mockLineShape.x2);
      expect(updated.y2).not.toBe(mockLineShape.y2);
    });

    it("should update text shape bounds", () => {
      const newBounds: BoundingBox = { x: 20, y: 30, width: 120, height: 90 };
      const updated = updateShapeBounds(mockTextShape, newBounds);

      expect(updated).toEqual({
        ...mockTextShape,
        x: 20,
        y: 30,
        width: 120,
        height: 90,
      });
    });
  });

  describe("moveShape", () => {
    it("should move a square shape to new position", () => {
      const moved = moveShape(mockSquareShape, 50, 60);

      expect(moved).toEqual({
        ...mockSquareShape,
        x: 50,
        y: 60,
      });
    });

    it("should move a line shape to new position", () => {
      const moved = moveShape(mockLineShape, 50, 60);

      // Calculate expected delta
      const deltaX = 50 - mockLineShape.x;
      const deltaY = 60 - mockLineShape.y;

      expect(moved).toEqual({
        ...mockLineShape,
        x: 50,
        y: 60,
        x1: mockLineShape.x1 + deltaX,
        y1: mockLineShape.y1 + deltaY,
        x2: mockLineShape.x2 + deltaX,
        y2: mockLineShape.y2 + deltaY,
      });
    });

    it("should move a text shape to new position", () => {
      const moved = moveShape(mockTextShape, 50, 60);

      expect(moved).toEqual({
        ...mockTextShape,
        x: 50,
        y: 60,
      });
    });
  });
});

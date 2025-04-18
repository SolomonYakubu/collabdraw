/**
 * Tests for useAlignmentGuides hook
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react-hooks";
import { useAlignmentGuides } from "../../hooks/canvas/useAlignmentGuides";
import { Shape } from "../../types/shapes";
import * as drawingService from "../../services/canvas/drawingService";

// Mock the drawing service
vi.mock("../../services/canvas/drawingService", () => ({
  getShapeBoundingBox: vi.fn((shape) => {
    // Simple mock implementation based on shape data
    return {
      x: shape.x,
      y: shape.y,
      width: shape.width || 100,
      height: shape.height || 80,
    };
  }),
}));

describe("useAlignmentGuides Hook", () => {
  // Mock shapes for testing
  const mockShapes: Shape[] = [
    {
      id: "shape1",
      tool: "Square",
      x: 10,
      y: 20,
      width: 100,
      height: 80,
      points: [],
      stroke: "#000000",
      strokeWidth: 2,
      fill: "transparent",
    },
    {
      id: "shape2",
      tool: "Square",
      x: 150,
      y: 20, // Same y position to trigger horizontal alignment
      width: 100,
      height: 100,
      points: [],
      stroke: "#000000",
      strokeWidth: 2,
      fill: "transparent",
    },
    {
      id: "shape3",
      tool: "Square",
      x: 10, // Same x position to trigger vertical alignment
      y: 150,
      width: 80,
      height: 80,
      points: [],
      stroke: "#000000",
      strokeWidth: 2,
      fill: "transparent",
    },
  ];

  // Mock active shape that will be aligned
  const activeShape: Shape = {
    id: "active",
    tool: "Square",
    x: 300,
    y: 21, // Close to shape2's y (20) to trigger alignment
    width: 50,
    height: 50,
    points: [],
    stroke: "#000000",
    strokeWidth: 2,
    fill: "transparent",
  };

  // Create a mock canvas context for testing
  const createMockContext = () => {
    return {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      strokeStyle: "",
      lineWidth: 0,
      setLineDash: vi.fn(),
      canvas: {
        width: 800,
        height: 600,
      },
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should initialize with empty guides", () => {
    const { result } = renderHook(() =>
      useAlignmentGuides({ shapes: mockShapes })
    );
    expect(result.current.alignmentGuides).toEqual([]);
  });

  it("should find horizontal alignment guides", () => {
    const { result } = renderHook(() =>
      useAlignmentGuides({ shapes: mockShapes })
    );

    act(() => {
      const guides = result.current.findAlignmentGuides(activeShape);

      // Should find at least one horizontal guide (y axis alignment)
      expect(guides.some((g) => g.orientation === "horizontal")).toBe(true);
      expect(guides.some((g) => g.position === 20)).toBe(true); // shape2's y
    });

    // Should update the state
    expect(result.current.alignmentGuides.length).toBeGreaterThan(0);
  });

  it("should draw alignment guides on the canvas", () => {
    const { result } = renderHook(() =>
      useAlignmentGuides({ shapes: mockShapes })
    );
    const mockContext = createMockContext();

    // First set some alignment guides
    act(() => {
      result.current.findAlignmentGuides(activeShape);
    });

    // Then draw them
    act(() => {
      result.current.drawAlignmentGuides(
        mockContext as unknown as CanvasRenderingContext2D
      );
    });

    // Verify the draw operations were called
    expect(mockContext.save).toHaveBeenCalled();
    expect(mockContext.beginPath).toHaveBeenCalled();
    expect(mockContext.stroke).toHaveBeenCalled();
    expect(mockContext.restore).toHaveBeenCalled();
  });

  it("should clear alignment guides", () => {
    const { result } = renderHook(() =>
      useAlignmentGuides({ shapes: mockShapes })
    );

    // First set some alignment guides
    act(() => {
      result.current.findAlignmentGuides(activeShape);
    });

    // Verify guides exist
    expect(result.current.alignmentGuides.length).toBeGreaterThan(0);

    // Clear the guides
    act(() => {
      result.current.clearAlignmentGuides();
    });

    // Verify guides are cleared
    expect(result.current.alignmentGuides).toEqual([]);
  });

  it("should snap shapes to alignment guides", () => {
    const { result } = renderHook(() =>
      useAlignmentGuides({ shapes: mockShapes })
    );

    // First set some alignment guides
    act(() => {
      result.current.findAlignmentGuides(activeShape);
    });

    // Try to snap a shape
    let snappedShape: Shape;
    act(() => {
      snappedShape = result.current.snapShapeToGuides(activeShape);
    });

    // If there are horizontal guides, the shape's y should have been adjusted
    if (
      result.current.alignmentGuides.some((g) => g.orientation === "horizontal")
    ) {
      expect(snappedShape.y).not.toEqual(activeShape.y);
    }
  });
});

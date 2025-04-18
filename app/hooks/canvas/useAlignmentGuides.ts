/**
 * Custom hook for handling alignment guides
 */
import { useCallback, useState } from "react";
import { Shape, BoundingBox, AlignmentGuide } from "../../types/shapes";
import { getShapeBoundingBox } from "../../services/canvas/drawingService";

export interface UseAlignmentGuidesProps {
  shapes: Shape[];
  snapThreshold?: number;
}

export interface UseAlignmentGuidesResult {
  alignmentGuides: AlignmentGuide[];
  findAlignmentGuides: (activeShape: Shape) => AlignmentGuide[];
  drawAlignmentGuides: (context: CanvasRenderingContext2D) => void;
  clearAlignmentGuides: () => void;
  snapShapeToGuides: (shape: Shape) => Shape;
}

export const useAlignmentGuides = ({
  shapes,
  snapThreshold = 5,
}: UseAlignmentGuidesProps): UseAlignmentGuidesResult => {
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);

  /**
   * Find alignment guides for a given shape
   */
  const findAlignmentGuides = useCallback(
    (activeShape: Shape): AlignmentGuide[] => {
      if (!activeShape) return [];

      const activeBox = getShapeBoundingBox(activeShape);
      const guides: AlignmentGuide[] = [];

      // Points to check for alignment
      const activePoints = {
        x: [
          activeBox.x,
          activeBox.x + activeBox.width / 2,
          activeBox.x + activeBox.width,
        ],
        y: [
          activeBox.y,
          activeBox.y + activeBox.height / 2,
          activeBox.y + activeBox.height,
        ],
      };

      // Check other shapes for alignment
      shapes.forEach((shape) => {
        if (shape.id === activeShape.id) return;

        const box = getShapeBoundingBox(shape);

        // Points from existing shape
        const points = {
          x: [box.x, box.x + box.width / 2, box.x + box.width],
          y: [box.y, box.y + box.height / 2, box.y + box.height],
        };

        // Check for horizontal alignment
        activePoints.y.forEach((activeY) => {
          points.y.forEach((y) => {
            if (Math.abs(activeY - y) < snapThreshold) {
              guides.push({
                position: y,
                orientation: "horizontal",
              });
            }
          });
        });

        // Check for vertical alignment
        activePoints.x.forEach((activeX) => {
          points.x.forEach((x) => {
            if (Math.abs(activeX - x) < snapThreshold) {
              guides.push({
                position: x,
                orientation: "vertical",
              });
            }
          });
        });
      });

      setAlignmentGuides(guides);
      return guides;
    },
    [shapes, snapThreshold]
  );

  /**
   * Draw the alignment guides on the canvas
   */
  const drawAlignmentGuides = useCallback(
    (context: CanvasRenderingContext2D) => {
      if (!alignmentGuides.length) return;

      context.save();
      context.strokeStyle = "#4285f4"; // Google blue
      context.lineWidth = 1;
      context.setLineDash([4, 4]); // Dashed line for guides

      alignmentGuides.forEach((guide) => {
        if (!context.canvas) return;

        if (guide.orientation === "horizontal") {
          context.beginPath();
          context.moveTo(0, guide.position);
          context.lineTo(context.canvas.width, guide.position);
          context.stroke();
        } else {
          context.beginPath();
          context.moveTo(guide.position, 0);
          context.lineTo(guide.position, context.canvas.height);
          context.stroke();
        }
      });

      context.restore();
    },
    [alignmentGuides]
  );

  /**
   * Clear all alignment guides
   */
  const clearAlignmentGuides = useCallback(() => {
    setAlignmentGuides([]);
  }, []);

  /**
   * Snap a shape to the active alignment guides
   */
  const snapShapeToGuides = useCallback(
    (shape: Shape): Shape => {
      if (!alignmentGuides.length) return shape;

      let snappedShape = { ...shape };
      const box = getShapeBoundingBox(snappedShape);

      // Apply horizontal snapping
      const horizontalGuide = alignmentGuides.find(
        (g) => g.orientation === "horizontal"
      );

      if (horizontalGuide) {
        // Snap to different positions depending on which edge is closest
        const distanceToTop = Math.abs(box.y - horizontalGuide.position);
        const distanceToCenter = Math.abs(
          box.y + box.height / 2 - horizontalGuide.position
        );
        const distanceToBottom = Math.abs(
          box.y + box.height - horizontalGuide.position
        );

        const minDistance = Math.min(
          distanceToTop,
          distanceToCenter,
          distanceToBottom
        );

        let offsetY = 0;
        if (minDistance === distanceToTop) {
          // Snap top edge
          offsetY = horizontalGuide.position - box.y;
        } else if (minDistance === distanceToCenter) {
          // Snap center
          const center = box.y + box.height / 2;
          offsetY = horizontalGuide.position - center;
        } else {
          // Snap bottom edge
          const bottom = box.y + box.height;
          offsetY = horizontalGuide.position - bottom;
        }

        snappedShape.y += offsetY;

        // Also update x1, y1, x2, y2 for line/arrow shapes
        if (snappedShape.tool === "Line" || snappedShape.tool === "Arrow") {
          snappedShape.y1 += offsetY;
          snappedShape.y2 += offsetY;
        }
      }

      // Apply vertical snapping
      const verticalGuide = alignmentGuides.find(
        (g) => g.orientation === "vertical"
      );

      if (verticalGuide) {
        // Snap to different positions depending on which edge is closest
        const distanceToLeft = Math.abs(box.x - verticalGuide.position);
        const distanceToCenter = Math.abs(
          box.x + box.width / 2 - verticalGuide.position
        );
        const distanceToRight = Math.abs(
          box.x + box.width - verticalGuide.position
        );

        const minDistance = Math.min(
          distanceToLeft,
          distanceToCenter,
          distanceToRight
        );

        let offsetX = 0;
        if (minDistance === distanceToLeft) {
          // Snap left edge
          offsetX = verticalGuide.position - box.x;
        } else if (minDistance === distanceToCenter) {
          // Snap center
          const center = box.x + box.width / 2;
          offsetX = verticalGuide.position - center;
        } else {
          // Snap right edge
          const right = box.x + box.width;
          offsetX = verticalGuide.position - right;
        }

        snappedShape.x += offsetX;

        // Also update x1, y1, x2, y2 for line/arrow shapes
        if (snappedShape.tool === "Line" || snappedShape.tool === "Arrow") {
          snappedShape.x1 += offsetX;
          snappedShape.x2 += offsetX;
        }
      }

      return snappedShape;
    },
    [alignmentGuides]
  );

  return {
    alignmentGuides,
    findAlignmentGuides,
    drawAlignmentGuides,
    clearAlignmentGuides,
    snapShapeToGuides,
  };
};

/**
 * Shape service - utility functions for manipulating shapes
 */
import { Shape, GroupShape } from "../../types/shapes";
import { getShapeBoundingBox } from "./drawingService";

/**
 * Group multiple shapes into a single group shape
 * @param shapes The shapes to group
 * @param groupId Optional ID for the group (generated if not provided)
 * @returns A new group shape containing the provided shapes
 */
export const groupShapes = (
  shapes: Shape[],
  groupId?: string | number
): GroupShape | null => {
  if (!shapes.length) return null;

  // Calculate the bounding box that contains all shapes
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  // Get the IDs of shapes to group
  const childIds = shapes.map((shape) => shape.id);

  // Calculate the bounds of the group
  shapes.forEach((shape) => {
    const bounds = getShapeBoundingBox(shape);
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  });

  // Create the group shape
  const groupShape: GroupShape = {
    id: groupId || `group-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    tool: "Group",
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    childIds,
    points: [],
    stroke: "transparent",
    strokeWidth: 1,
    fill: "transparent",
  };

  return groupShape;
};

/**
 * Ungroup a group shape and return its child shapes
 * @param groupShape The group shape to ungroup
 * @param allShapes All available shapes to find the children from
 * @returns The child shapes that were in the group
 */
export const ungroupShapes = (
  groupShape: GroupShape,
  allShapes: Shape[]
): Shape[] => {
  if (groupShape.tool !== "Group" || !groupShape.childIds) {
    return [];
  }

  // Find all child shapes by their IDs
  return allShapes.filter((shape) => groupShape.childIds.includes(shape.id));
};

/**
 * Check if a shape is part of any group
 * @param shape The shape to check
 * @param groups All group shapes
 * @returns The ID of the group containing the shape, or null if not in a group
 */
export const isShapeInGroup = (
  shape: Shape,
  groups: GroupShape[]
): string | number | null => {
  for (const group of groups) {
    if (group.childIds.includes(shape.id)) {
      return group.id;
    }
  }
  return null;
};

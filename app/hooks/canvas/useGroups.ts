/**
 * Custom hook for managing shape groups
 */
import { useCallback } from "react";
import { Shape, GroupShape } from "../../types/shapes";
import {
  groupShapes,
  ungroupShapes,
  isShapeInGroup,
} from "../../services/canvas/shapeService";

interface UseGroupsProps {
  shapes: Shape[];
  setShapes: (shapes: Shape[] | ((prevShapes: Shape[]) => Shape[])) => void;
  selectedId: string | number | null;
  setSelectedId: (id: string | number | null) => void;
  saveToHistory?: () => void;
  onShapeUpdated?: (shape: Shape) => void;
}

export const useGroups = ({
  shapes,
  setShapes,
  selectedId,
  setSelectedId,
  saveToHistory,
  onShapeUpdated,
}: UseGroupsProps) => {
  /**
   * Create a group from selected shapes
   */
  const createGroup = useCallback(() => {
    // Find all selected shapes to group
    const selectedShapes = shapes.filter((shape) => shape.selected);

    if (selectedShapes.length < 2) {
      // Need at least 2 shapes to form a group
      return;
    }

    // Create the group
    const group = groupShapes(selectedShapes);
    if (!group) return;

    // Update the state with the group
    setShapes((prevShapes) => {
      // Mark all shapes in the group as not selected
      const updatedShapes = prevShapes.map((shape) => {
        if (group.childIds.includes(shape.id)) {
          return { ...shape, selected: false };
        }
        return shape;
      });

      // Add the new group
      const newShapes = [...updatedShapes, { ...group, selected: true }];

      // Notify about the update if callback provided
      if (onShapeUpdated) {
        onShapeUpdated(group);
      }

      return newShapes;
    });

    // Select the new group
    setSelectedId(group.id);

    // Save to history if available
    if (saveToHistory) {
      saveToHistory();
    }
  }, [shapes, setShapes, setSelectedId, saveToHistory, onShapeUpdated]);

  /**
   * Ungroup a selected group
   */
  const ungroup = useCallback(() => {
    if (!selectedId) return;

    // Find the selected group
    const group = shapes.find(
      (shape): shape is GroupShape =>
        shape.id === selectedId && shape.tool === "Group"
    );

    if (!group) return; // Not a group or not found

    // Get the child shapes
    const childShapes = ungroupShapes(group, shapes);
    if (!childShapes.length) return;

    // Update the state
    setShapes((prevShapes) => {
      // Select all child shapes and remove the group
      const newShapes = prevShapes
        .filter((shape) => shape.id !== group.id)
        .map((shape) => {
          if (group.childIds.includes(shape.id)) {
            return { ...shape, selected: true };
          }
          return shape;
        });

      return newShapes;
    });

    // Deselect the group
    setSelectedId(null);

    // Save to history if available
    if (saveToHistory) {
      saveToHistory();
    }
  }, [selectedId, shapes, setShapes, setSelectedId, saveToHistory]);

  /**
   * Check if the currently selected shape is a group
   */
  const isGroup = useCallback(() => {
    if (!selectedId) return false;

    const selectedShape = shapes.find((shape) => shape.id === selectedId);
    return !!selectedShape && selectedShape.tool === "Group";
  }, [selectedId, shapes]);

  /**
   * Check if the provided shape is part of any group
   */
  const checkIfInGroup = useCallback(
    (shape: Shape) => {
      const groups = shapes.filter((s): s is GroupShape => s.tool === "Group");
      return isShapeInGroup(shape, groups);
    },
    [shapes]
  );

  return {
    createGroup,
    ungroup,
    isGroup,
    checkIfInGroup,
  };
};

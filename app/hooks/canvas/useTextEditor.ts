"use client";

/**
 * Text editing via a real <textarea> overlay.
 *
 * The previous implementation reimplemented a text editor on top of a
 * `document` keydown listener: it dropped keystrokes behind a 10 ms "handled"
 * flag, had no IME, clipboard, selection or mobile keyboard support, and drew a
 * blinking caret from `Date.now()` with nothing driving a repaint. A textarea
 * gets all of that from the platform for free.
 */
import { useCallback, useRef, useState } from "react";
import type { ElementStyle, Point, Shape, TextShape } from "../../types/shapes";
import {
  createElement,
  getElementBounds,
  mutateElement,
} from "../../services/canvas/elements";
import { measureTextElement } from "../../services/canvas/textMeasure";
import {
  getBoundLabel,
  layoutBoundText,
  reflowContainerWithLabel,
} from "../../services/canvas/boundText";
import type { ApplyOptions, ElementsUpdater } from "./useScene";

export interface UseTextEditorProps {
  elementsRef: React.MutableRefObject<Shape[]>;
  applyElements: (updater: ElementsUpdater, options?: ApplyOptions) => Shape[];
  style: ElementStyle;
  setSelectedIds: (ids: string[]) => void;
}

export interface TextEditorState {
  editingId: string | null;
  editingElement: TextShape | null;
  startEditing: (elementId: string) => void;
  createAndEdit: (point: Point, containerId?: string | null) => void;
  updateText: (text: string) => void;
  stopEditing: () => void;
}

export const useTextEditor = ({
  elementsRef,
  applyElements,
  style,
  setSelectedIds,
}: UseTextEditorProps): TextEditorState => {
  const [editingId, setEditingId] = useState<string | null>(null);

  /** Text as of the moment editing began, so a no-op edit is not committed. */
  const initialTextRef = useRef<string>("");
  /** Elements created purely to be typed into get removed if left empty. */
  const createdRef = useRef<boolean>(false);

  const styleRef = useRef(style);
  styleRef.current = style;

  const findText = useCallback(
    (id: string | null): TextShape | null => {
      if (!id) {
        return null;
      }
      const element = elementsRef.current.find((item) => item.id === id);
      return element && element.tool === "Text" ? (element as TextShape) : null;
    },
    [elementsRef],
  );

  const startEditing = useCallback(
    (elementId: string) => {
      const element = findText(elementId);
      if (!element) {
        return;
      }

      initialTextRef.current = element.text;
      createdRef.current = false;
      setEditingId(elementId);
      setSelectedIds([elementId]);
    },
    [findText, setSelectedIds],
  );

  const createAndEdit = useCallback(
    (point: Point, containerId: string | null = null) => {
      const container = containerId
        ? elementsRef.current.find((element) => element.id === containerId) ?? null
        : null;

      // A container may already have a label: edit that instead of adding one.
      if (container) {
        const existing = getBoundLabel(container, elementsRef.current);
        if (existing) {
          startEditing(existing.id);
          return;
        }
      }

      const created = createElement(
        "Text",
        {
          x: point.x,
          y: point.y - styleRef.current.fontSize / 2,
          text: "",
          containerId: container?.id ?? null,
        },
        styleRef.current.stroke,
        styleRef.current,
      ) as TextShape | null;

      if (!created) {
        return;
      }

      const label = container ? layoutBoundText(created, container) : created;

      applyElements(
        (previous) => {
          const next = [...previous, label];

          if (!container) {
            return next;
          }

          return next.map((element) =>
            element.id === container.id
              ? mutateElement(element, {
                  boundElements: [
                    ...(element.boundElements ?? []),
                    { id: label.id, type: "text" as const },
                  ],
                })
              : element,
          );
        },
        // Not committed: an empty text element that is abandoned should not
        // leave an undo step behind.
        { commit: false, changedIds: [label.id] },
      );

      initialTextRef.current = "";
      createdRef.current = true;
      setEditingId(label.id);
      setSelectedIds([label.id]);
    },
    [applyElements, elementsRef, setSelectedIds, startEditing],
  );

  const updateText = useCallback(
    (text: string) => {
      const id = editingId;
      if (!id) {
        return;
      }

      applyElements(
        (previous) => {
          const current = previous.find((element) => element.id === id);
          if (!current || current.tool !== "Text") {
            return previous;
          }

          const label = current as TextShape;
          const withText = mutateElement(label, { text });

          if (!label.containerId) {
            // Free text grows with its content.
            const measured = measureTextElement(withText);
            const resized = mutateElement(withText, {
              width: measured.width,
              height: measured.height,
            });
            return previous.map((element) =>
              element.id === id ? resized : element,
            );
          }

          const next = previous.map((element) =>
            element.id === id ? withText : element,
          );
          return reflowContainerWithLabel(next, label.containerId);
        },
        { commit: false, changedIds: [id] },
      );
    },
    [applyElements, editingId],
  );

  const stopEditing = useCallback(() => {
    const id = editingId;
    if (!id) {
      return;
    }

    setEditingId(null);

    const element = findText(id);
    if (!element) {
      return;
    }

    const text = element.text.trim();
    const wasCreated = createdRef.current;
    const changed = element.text !== initialTextRef.current;
    createdRef.current = false;

    if (text === "") {
      // Empty text is dropped, and its container loses the back-reference.
      applyElements(
        (previous) =>
          previous
            .filter((item) => item.id !== id)
            .map((item) =>
              item.boundElements?.some((bound) => bound.id === id)
                ? mutateElement(item, {
                    boundElements:
                      item.boundElements.filter((bound) => bound.id !== id)
                        .length > 0
                        ? item.boundElements.filter((bound) => bound.id !== id)
                        : null,
                  })
                : item,
            ),
        {
          // Nothing to undo if the element never really existed.
          commit: !wasCreated,
          deletedIds: [id],
        },
      );
      setSelectedIds([]);
      return;
    }

    if (!changed && !wasCreated) {
      return;
    }

    // Commit the finished text as a single undo step.
    applyElements((previous) => [...previous], { changedIds: [id] });
  }, [applyElements, editingId, findText, setSelectedIds]);

  const editingElement = findText(editingId);

  return {
    editingId,
    editingElement,
    startEditing,
    createAndEdit,
    updateText,
    stopEditing,
  };
};

/** Screen-space geometry for positioning the textarea over the element. */
export const getTextEditorGeometry = (
  element: TextShape,
): { bounds: ReturnType<typeof getElementBounds> } => ({
  bounds: getElementBounds(element),
});

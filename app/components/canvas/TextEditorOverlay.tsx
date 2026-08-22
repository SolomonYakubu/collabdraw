"use client";

/**
 * The text editing surface: a transparent <textarea> laid exactly over the text
 * element being edited, so the platform provides caret, selection, clipboard,
 * IME and mobile keyboards.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import type { TextShape, Viewport } from "../../types/shapes";
import { getLineHeight } from "../../services/canvas/textMeasure";
import { worldToScreen } from "../../utils/viewport";
import { BOUND_TEXT_PADDING } from "../../services/canvas/boundText";

interface TextEditorOverlayProps {
  element: TextShape;
  viewport: Viewport;
  /**
   * The same filter the element layer uses. The editor has to match it or the
   * text would change colour the moment editing started.
   */
  canvasFilter: string;
  onChange: (text: string) => void;
  onFinish: () => void;
}

const TextEditorOverlay: React.FC<TextEditorOverlayProps> = ({
  element,
  viewport,
  canvasFilter,
  onChange,
  onFinish,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;

  // Focus and put the caret at the end, matching what a click into text does.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.focus({ preventScroll: true });
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
  }, [element.id]);

  // Any pointer press outside the editor ends editing.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (
        textareaRef.current &&
        !textareaRef.current.contains(event.target as Node)
      ) {
        finishRef.current();
      }
    };

    // Deferred so the press that opened the editor does not close it.
    const timer = window.setTimeout(() => {
      window.addEventListener("pointerdown", onPointerDown, true);
    }, 0);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);

  const { zoom } = viewport;
  const isLabel = Boolean(element.containerId);
  const screen = worldToScreen(element.x, element.y, viewport);
  const lineHeight = getLineHeight(element.fontSize);

  /*
   * The editor sits on top of a rotated element, so it has to turn with it —
   * about the element's own centre, which in the textarea's own box is its
   * middle. Expressed in degrees because CSS wants degrees.
   */
  const rotation = element.angle === 0
    ? undefined
    : `rotate(${(element.angle * 180) / Math.PI}deg)`;

  // Free text sizes itself to the content; a label is constrained by its box.
  const width = Math.max(element.width, element.fontSize) * zoom;
  const height = Math.max(element.height, lineHeight) * zoom;

  return (
    <textarea
      ref={textareaRef}
      value={element.text}
      onChange={(event) => onChange(event.target.value)}
      onBlur={() => finishRef.current()}
      onKeyDown={(event) => {
        // Keep canvas shortcuts (delete, tool switching, undo) from firing.
        event.stopPropagation();

        if (event.key === "Escape") {
          event.preventDefault();
          finishRef.current();
          return;
        }

        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          finishRef.current();
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      spellCheck={false}
      wrap={isLabel ? "soft" : "off"}
      className="absolute z-50 resize-none overflow-hidden border-0 bg-transparent p-0 outline-none"
      style={{
        left: `${screen.x}px`,
        top: `${screen.y}px`,
        transform: rotation,
        transformOrigin: "center center",
        width: `${width}px`,
        height: `${height}px`,
        minWidth: `${element.fontSize * zoom}px`,
        fontSize: `${element.fontSize * zoom}px`,
        fontFamily: element.fontFamily,
        lineHeight: `${lineHeight * zoom}px`,
        color: element.stroke,
        textAlign: element.textAlign,
        opacity: element.opacity / 100,
        whiteSpace: isLabel ? "pre-wrap" : "pre",
        filter: canvasFilter,
        padding: isLabel ? `0 ${BOUND_TEXT_PADDING * zoom}px` : 0,
        // The canvas already paints this element's glyphs; hiding the caret's
        // own text would lose the caret, so the canvas skips it while editing.
        caretColor: element.stroke,
      }}
    />
  );
};

export default TextEditorOverlay;

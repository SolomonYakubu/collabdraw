/**
 * Text labels bound to a container shape.
 *
 * Double-clicking a container shape edits a label that lives inside it, stays
 * centred, wraps to the container width and grows the container when it runs out
 * of room — the Excalidraw behaviour.
 */
import type { Shape, TextShape } from "../../types/shapes";
import { getElementBounds, mutateElement } from "./elements";
import { getLineHeight, measureTextWidth, wrapText } from "./textMeasure";

export const BOUND_TEXT_PADDING = 5;

/**
 * The rectangle a label may occupy inside a container. Ellipses and diamonds
 * only inscribe part of their bounding box, so their usable area is smaller.
 */
/**
 * How much of a container's bounding box a label may use. A shape that only
 * inscribes part of its box has less room than its dimensions suggest.
 */
export const getInnerRatio = (container: Shape): number => {
  switch (container.tool) {
    case "Circle":
      return 1 / Math.SQRT2;
    case "Diamond":
    case "Triangle":
      return 0.5;
    default:
      return 1;
  }
};

export const getContainerTextBox = (container: Shape) => {
  const bounds = getElementBounds(container);
  const ratio = getInnerRatio(container);

  const width = Math.max(
    BOUND_TEXT_PADDING * 2,
    bounds.width * ratio - BOUND_TEXT_PADDING * 2,
  );
  const height = Math.max(
    BOUND_TEXT_PADDING * 2,
    bounds.height * ratio - BOUND_TEXT_PADDING * 2,
  );

  // A triangle has no room at its apex, so its label sits in the lower half
  // where the shape is actually wide.
  const verticalBias = container.tool === "Triangle" ? 0.25 : 0;

  return {
    x: bounds.x + (bounds.width - width) / 2,
    y:
      bounds.y +
      (bounds.height - height) / 2 +
      bounds.height * verticalBias,
    width,
    height,
  };
};

/**
 * Invert `getContainerTextBox`: the outer box a shape needs so that a label of
 * this size fits inside it.
 *
 * Sizing a node by multiplying its text width by a guessed factor did not
 * survive contact with the shapes that only inscribe part of their box — a
 * diamond's factor was too small, so its label overflowed and then had its font
 * silently shrunk to compensate.
 */
export const getRequiredContainerSize = (
  tool: Shape["tool"],
  content: { width: number; height: number },
  padding = 0,
): { width: number; height: number } => {
  const ratio = getInnerRatio({ tool } as Shape);

  return {
    width: (content.width + BOUND_TEXT_PADDING * 2) / ratio + padding * 2,
    height: (content.height + BOUND_TEXT_PADDING * 2) / ratio + padding,
  };
};

/** Height a label needs at a given width. */
export const measureBoundText = (
  text: string,
  width: number,
  fontSize: number,
  fontFamily: string,
): { width: number; height: number; lines: string[] } => {
  const lines = wrapText(text, width, fontSize, fontFamily);
  const lineHeight = getLineHeight(fontSize);

  return {
    width: lines.reduce(
      (max, line) => Math.max(max, measureTextWidth(line, fontSize, fontFamily)),
      0,
    ),
    height: Math.max(1, lines.length) * lineHeight,
    lines,
  };
};

/** Re-lay-out a label inside its container. */
export const layoutBoundText = (
  label: TextShape,
  container: Shape,
): TextShape => {
  const box = getContainerTextBox(container);
  const measured = measureBoundText(
    label.text,
    box.width,
    label.fontSize,
    label.fontFamily,
  );

  return mutateElement(label, {
    x: box.x,
    y: box.y + Math.max(0, (box.height - measured.height) / 2),
    width: box.width,
    height: measured.height,
    textAlign: "center",
    verticalAlign: "middle",
  });
};

/** Labels stop shrinking here; below this they are unreadable anyway. */
const MIN_LABEL_FONT_SIZE = 10;

/**
 * Fit a label inside a container that is a fixed size.
 *
 * `layoutBoundText` wraps to the container's width but will happily centre a
 * block that is taller than the space available, which clipped labels — a "Bob"
 * in a small circle rendered as "Bo" over a cut-off "b". This shrinks the font
 * until the wrapped text fits, and only if it still does not fit does it grow the
 * container, so a deliberate composition keeps its proportions where it can.
 */
export const fitLabelToContainer = (
  label: TextShape,
  container: Shape,
): { label: TextShape; container: Shape } => {
  const box = getContainerTextBox(container);
  let fontSize = label.fontSize;

  while (fontSize > MIN_LABEL_FONT_SIZE) {
    const measured = measureBoundText(
      label.text,
      box.width,
      fontSize,
      label.fontFamily,
    );

    if (measured.height <= box.height && measured.width <= box.width) {
      break;
    }

    fontSize -= 1;
  }

  const sized = fontSize === label.fontSize
    ? label
    : mutateElement(label, { fontSize });

  const measured = measureBoundText(
    sized.text,
    box.width,
    fontSize,
    sized.fontFamily,
  );

  // Still too tall at the minimum readable size: the container has to give.
  if (measured.height > box.height) {
    const nextContainer = mutateElement(container, {
      height:
        (measured.height + BOUND_TEXT_PADDING * 2) / getInnerRatio(container),
    });

    return {
      container: nextContainer,
      label: layoutBoundText(sized, nextContainer),
    };
  }

  return { container, label: layoutBoundText(sized, container) };
};

/** The container a label belongs to, if it is still around. */
export const getLabelContainer = (
  label: TextShape,
  elements: readonly Shape[],
): Shape | null =>
  label.containerId
    ? elements.find((element) => element.id === label.containerId) ?? null
    : null;

/** The label attached to a container, if any. */
export const getBoundLabel = (
  container: Shape,
  elements: readonly Shape[],
): TextShape | null => {
  const entry = container.boundElements?.find((bound) => bound.type === "text");

  if (!entry) {
    return null;
  }

  const label = elements.find((element) => element.id === entry.id);
  return label && label.tool === "Text" ? (label as TextShape) : null;
};

/**
 * Grow a container so its label fits, and re-centre the label.
 * Returns the whole scene with both elements updated.
 */
export const reflowContainerWithLabel = (
  elements: readonly Shape[],
  containerId: string,
): Shape[] => {
  const container = elements.find((element) => element.id === containerId);

  if (!container) {
    return [...elements];
  }

  const label = getBoundLabel(container, elements);
  if (!label) {
    return [...elements];
  }

  const box = getContainerTextBox(container);
  const measured = measureBoundText(
    label.text,
    box.width,
    label.fontSize,
    label.fontFamily,
  );

  let nextContainer = container;

  // The container only ever grows; shrinking it while typing feels jumpy.
  const requiredInnerHeight = measured.height + BOUND_TEXT_PADDING * 2;
  const requiredHeight = requiredInnerHeight / getInnerRatio(container);

  if (requiredHeight > container.height) {
    nextContainer = mutateElement(container, {
      height: requiredHeight,
    });
  }

  const nextLabel = layoutBoundText(label, nextContainer);

  return elements.map((element) => {
    if (element.id === nextContainer.id) {
      return nextContainer;
    }
    if (element.id === nextLabel.id) {
      return nextLabel;
    }
    return element;
  });
};

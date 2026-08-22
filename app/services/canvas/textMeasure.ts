/**
 * Text measurement and layout.
 *
 * Uses one cached offscreen 2D context so measuring never allocates a canvas
 * per call (the previous implementation created one per bounding-box query).
 */
import { LINE_HEIGHT, type TextShape } from "../../types/shapes";

let measureContext: CanvasRenderingContext2D | null = null;

const getMeasureContext = (): CanvasRenderingContext2D | null => {
  if (measureContext) {
    return measureContext;
  }

  if (typeof document === "undefined") {
    return null;
  }

  measureContext = document.createElement("canvas").getContext("2d");
  return measureContext;
};

export const getFontString = (fontSize: number, fontFamily: string): string =>
  `${fontSize}px ${fontFamily}`;

/** Width of a single line, with a coarse fallback when there is no DOM. */
export const measureTextWidth = (
  text: string,
  fontSize: number,
  fontFamily: string,
): number => {
  const context = getMeasureContext();

  if (!context) {
    return text.length * fontSize * 0.55;
  }

  context.font = getFontString(fontSize, fontFamily);
  return context.measureText(text).width;
};

export const getLineHeight = (fontSize: number): number =>
  fontSize * LINE_HEIGHT;

/** Split on explicit newlines only; wrapping is handled separately. */
export const splitLines = (text: string): string[] => text.split("\n");

/** Greedy word wrap to a maximum width, preserving explicit newlines. */
export const wrapText = (
  text: string,
  maxWidth: number,
  fontSize: number,
  fontFamily: string,
): string[] => {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) {
    return splitLines(text);
  }

  const wrapped: string[] = [];

  for (const paragraph of splitLines(text)) {
    if (paragraph === "") {
      wrapped.push("");
      continue;
    }

    const words = paragraph.split(" ");
    let line = "";

    for (const word of words) {
      const candidate = line === "" ? word : `${line} ${word}`;

      if (measureTextWidth(candidate, fontSize, fontFamily) <= maxWidth) {
        line = candidate;
        continue;
      }

      if (line !== "") {
        wrapped.push(line);
      }

      // A single word longer than the line still has to be broken somewhere.
      if (measureTextWidth(word, fontSize, fontFamily) > maxWidth) {
        let chunk = "";
        for (const char of word) {
          if (
            chunk !== "" &&
            measureTextWidth(chunk + char, fontSize, fontFamily) > maxWidth
          ) {
            wrapped.push(chunk);
            chunk = char;
          } else {
            chunk += char;
          }
        }
        line = chunk;
      } else {
        line = word;
      }
    }

    wrapped.push(line);
  }

  return wrapped;
};

/** Lines as they will actually be rendered for this element. */
export const getTextLines = (element: TextShape): string[] =>
  element.containerId && element.width > 0
    ? wrapText(element.text, element.width, element.fontSize, element.fontFamily)
    : splitLines(element.text);

/** Intrinsic size of a text element's content. */
export const measureTextElement = (
  element: Pick<TextShape, "text" | "fontSize" | "fontFamily">,
): { width: number; height: number } => {
  const lines = splitLines(element.text);
  const width = lines.reduce(
    (max, line) =>
      Math.max(max, measureTextWidth(line, element.fontSize, element.fontFamily)),
    0,
  );

  return {
    width,
    height: Math.max(1, lines.length) * getLineHeight(element.fontSize),
  };
};

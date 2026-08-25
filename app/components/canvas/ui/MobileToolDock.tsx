"use client";

import React, { memo, useEffect, useRef, useState } from "react";
import {
  FiChevronUp,
  FiCircle,
  FiEdit3,
  FiMinus,
  FiMousePointer,
  FiSquare,
  FiType,
} from "react-icons/fi";
import { FaEraser } from "react-icons/fa";
import { LuDiamond, LuTriangle } from "react-icons/lu";
import { TbArrowNarrowRight } from "react-icons/tb";
import type { ElementStyle, ToolType } from "../../../types/shapes";

export interface MobileToolDockProps {
  tool: ToolType;
  onToolChange: (tool: ToolType) => void;
  style: ElementStyle;
  onToggleStyleSheet: () => void;
  isStyleSheetOpen: boolean;
  hasSelection: boolean;
}

interface ToolDef {
  tool: ToolType;
  icon: React.ReactNode;
  label: string;
}

// The geometric shapes collapse into a single dock slot with a picker. This is
// what keeps every control on one row on a phone: three buttons become one, so
// the contextual Style button no longer pushes the row into a scroll.
const SHAPE_TOOLS: ToolDef[] = [
  { tool: "Square", icon: <FiSquare size={17} />, label: "Rectangle" },
  { tool: "Diamond", icon: <LuDiamond size={17} />, label: "Diamond" },
  { tool: "Circle", icon: <FiCircle size={17} />, label: "Circle" },
  { tool: "Triangle", icon: <LuTriangle size={17} />, label: "Triangle" },
];

const LEADING_TOOLS: ToolDef[] = [
  { tool: "Select", icon: <FiMousePointer size={17} />, label: "Select" },
];

const TRAILING_TOOLS: ToolDef[] = [
  { tool: "Arrow", icon: <TbArrowNarrowRight size={20} />, label: "Arrow" },
  { tool: "Line", icon: <FiMinus size={18} />, label: "Line" },
  { tool: "Freehand", icon: <FiEdit3 size={17} />, label: "Draw" },
  { tool: "Text", icon: <FiType size={17} />, label: "Text" },
  { tool: "Eraser", icon: <FaEraser size={15} />, label: "Eraser" },
];

const ToolButton: React.FC<{ def: ToolDef; active: boolean; onSelect: () => void }> = ({
  def,
  active,
  onSelect,
}) => (
  <button
    type="button"
    aria-label={def.label}
    aria-pressed={active}
    data-active={active ? "true" : undefined}
    onClick={onSelect}
    className="island-button h-9 w-9 shrink-0"
  >
    {def.icon}
  </button>
);

const MobileToolDock: React.FC<MobileToolDockProps> = ({
  tool,
  onToolChange,
  style,
  onToggleStyleSheet,
  isStyleSheetOpen,
  hasSelection,
}) => {
  const [shapesOpen, setShapesOpen] = useState(false);
  // Remember the last shape drawn so the group button keeps that shape's face
  // instead of snapping back to the rectangle every time.
  const [lastShape, setLastShape] = useState<ToolType>("Square");

  const shapeActive = SHAPE_TOOLS.some((s) => s.tool === tool);
  const shownShape =
    SHAPE_TOOLS.find((s) => s.tool === (shapeActive ? tool : lastShape)) ??
    SHAPE_TOOLS[0];
  const showStyleButton = hasSelection || tool !== "Select";

  useEffect(() => {
    if (shapeActive) setLastShape(tool);
  }, [shapeActive, tool]);

  // Close the picker when switching to any non-shape tool.
  useEffect(() => {
    if (!shapeActive) setShapesOpen(false);
  }, [shapeActive]);

  const pickShape = (id: ToolType) => {
    onToolChange(id);
    setShapesOpen(false);
  };

  return (
    <nav
      aria-label="Drawing tools"
      className="pointer-events-none fixed inset-x-0 bottom-2 z-30 flex items-center justify-center md:hidden"
      style={{ bottom: "max(0.5rem, env(safe-area-inset-bottom, 0.5rem))" }}
    >
      {shapesOpen && (
        <button
          type="button"
          aria-label="Close shape picker"
          className="pointer-events-auto fixed inset-0 z-[-1] cursor-default"
          onClick={() => setShapesOpen(false)}
        />
      )}

      <div className="island pointer-events-auto flex items-center gap-0.5 p-1.5 shadow-xl">
        {LEADING_TOOLS.map((def) => (
          <ToolButton
            key={def.tool}
            def={def}
            active={tool === def.tool}
            onSelect={() => onToolChange(def.tool)}
          />
        ))}

        {/* Shapes group */}
        <div className="relative shrink-0">
          {shapesOpen && (
            <div
              role="menu"
              aria-label="Shapes"
              className="island animate-slide-up absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 items-center gap-0.5 p-1.5 shadow-xl"
            >
              {SHAPE_TOOLS.map((def) => (
                <ToolButton
                  key={def.tool}
                  def={def}
                  active={tool === def.tool}
                  onSelect={() => pickShape(def.tool)}
                />
              ))}
            </div>
          )}

          <button
            type="button"
            aria-label="Shapes"
            aria-haspopup="menu"
            aria-expanded={shapesOpen}
            aria-pressed={shapeActive}
            data-active={shapeActive ? "true" : undefined}
            onClick={() => setShapesOpen((open) => !open)}
            className="island-button relative h-9 w-9"
          >
            {shownShape.icon}
            <FiChevronUp
              size={9}
              className="absolute bottom-0.5 right-0.5 opacity-50"
              aria-hidden="true"
            />
          </button>
        </div>

        {TRAILING_TOOLS.map((def) => (
          <ToolButton
            key={def.tool}
            def={def}
            active={tool === def.tool}
            onSelect={() => onToolChange(def.tool)}
          />
        ))}

        {/* Style sheet button */}
        {showStyleButton && (
          <>
            <span className="divider mx-0.5 h-6 w-px shrink-0" aria-hidden="true" />
            <button
              type="button"
              onClick={onToggleStyleSheet}
              aria-label="Element Properties"
              aria-pressed={isStyleSheetOpen}
              data-active={isStyleSheetOpen ? "true" : undefined}
              className="island-button flex h-9 shrink-0 items-center gap-1.5 px-2"
            >
              <span
                className="h-4 w-4 rounded-full border border-black/20"
                style={{
                  backgroundColor: style.fill !== "transparent" ? style.fill : style.stroke,
                  borderColor: style.stroke,
                }}
              />
              <span className="text-[11px] font-semibold">Style</span>
            </button>
          </>
        )}
      </div>
    </nav>
  );
};

export default memo(MobileToolDock);

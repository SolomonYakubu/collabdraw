/**
 * Toolbar component - Contains drawing tools and controls
 */
import { useState, useEffect } from "react";
import { ShapeType } from "../../../types/shapes";

import {
  FiMousePointer,
  FiEdit3,
  FiSquare,
  FiCircle,
  FiType,
  FiArrowRight,
  FiDownload,
  FiLink,
  FiUsers,
  FiTrash2,
  FiCornerUpLeft,
  FiCornerUpRight,
  FiMinus,
  FiSettings,
  FiMove,
  FiGrid,
  FiLayers,
  FiDroplet,
} from "react-icons/fi";
import { FaEraser, FaFillDrip } from "react-icons/fa";
import { LuDiamond } from "react-icons/lu";
import { RxDragHandleDots2 } from "react-icons/rx";

interface ToolbarProps {
  selectedTool: ShapeType;
  onSelectTool: (tool: ShapeType) => void;
  selectedColor: string;
  onSelectColor: (color: string) => void;
  selectedFillColor: string;
  onSelectFillColor: (color: string, options?: any) => void;
  onClearCanvas: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onSave: () => void;
  onGenerateLink?: () => void;
  shareableLink?: string;
  showLinkCopied?: boolean;
  toggleUserPanel?: () => void;
  selectedShapeFill?: string;
  onChangeSelectedShapeFill?: (color: string, options?: any) => void;
  hasSelectedShape?: boolean;
  selectedShapeOptions?: { fillStyle?: string; roughness?: number };
  defaultFillStyle?: string;
}

const Toolbar: React.FC<ToolbarProps> = ({
  selectedTool,
  onSelectTool,
  selectedColor,
  onSelectColor,
  selectedFillColor,
  onSelectFillColor,
  onClearCanvas,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onSave,
  onGenerateLink,
  shareableLink,
  showLinkCopied,
  toggleUserPanel,
  selectedShapeFill,
  onChangeSelectedShapeFill,
  hasSelectedShape,
  selectedShapeOptions,
  defaultFillStyle,
}) => {
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showFillColorPicker, setShowFillColorPicker] = useState(false);
  const [lastSelectedTool, setLastSelectedTool] = useState<ShapeType | null>(
    null
  );
  const [animateTool, setAnimateTool] = useState<ShapeType | null>(null);

  // Get the active fill color - either from selected shape or default
  const activeFillColor =
    hasSelectedShape && selectedShapeFill
      ? selectedShapeFill
      : selectedFillColor;
  const isFillTransparent =
    activeFillColor === "transparent" || activeFillColor === "none";

  // Handle fill color selection
  const handleFillColorSelect = (color: string) => {
    if (hasSelectedShape && onChangeSelectedShapeFill) {
      // Update selected shape's fill
      onChangeSelectedShapeFill(color);
    } else {
      // Update default fill for new shapes
      onSelectFillColor(color);
    }
    setShowFillColorPicker(false);
  };

  // Handle tool selection animation
  useEffect(() => {
    if (selectedTool !== lastSelectedTool) {
      setAnimateTool(selectedTool);
      setLastSelectedTool(selectedTool);

      const timer = setTimeout(() => {
        setAnimateTool(null);
      }, 300);

      return () => clearTimeout(timer);
    }
  }, [selectedTool, lastSelectedTool]);

  // Close other color picker when one is opened
  useEffect(() => {
    if (showColorPicker) {
      setShowFillColorPicker(false);
    }
  }, [showColorPicker]);

  useEffect(() => {
    if (showFillColorPicker) {
      setShowColorPicker(false);
    }
  }, [showFillColorPicker]);

  // Available drawing tools with improved icons using react-icons
  const tools: { id: ShapeType; label: string; icon: React.ReactNode }[] = [
    {
      id: "Select",
      label: "Select",
      icon: <FiMousePointer size={18} />,
    },
    {
      id: "Pan",
      label: "Pan",
      icon: <RxDragHandleDots2 size={18} />,
    },
    {
      id: "Freehand",
      label: "Draw",
      icon: <FiEdit3 size={18} />,
    },
    {
      id: "Line",
      label: "Line",
      icon: <FiMinus size={18} />,
    },
    {
      id: "Arrow",
      label: "Arrow",
      icon: <FiArrowRight size={18} />,
    },
    {
      id: "Square",
      label: "Square",
      icon: <FiSquare size={18} />,
    },
    {
      id: "Circle",
      label: "Circle",
      icon: <FiCircle size={18} />,
    },
    {
      id: "Diamond",
      label: "Diamond",
      icon: (
        <LuDiamond
          size={18}
          className={selectedTool === "Diamond" ? "diamond-shape-selected" : ""}
        />
      ),
    },
    {
      id: "Text",
      label: "Text",
      icon: <FiType size={18} />,
    },
    {
      id: "Eraser",
      label: "Eraser",
      icon: <FaEraser size={16} />,
    },
  ];

  // Enhanced color palette with modern design colors
  const colors = [
    "#000000", // Black
    "#3f51b5", // Indigo
    "#2196f3", // Blue
    "#03a9f4", // Light Blue
    "#00bcd4", // Cyan
    "#009688", // Teal
    "#4caf50", // Green
    "#8bc34a", // Light Green
    "#cddc39", // Lime
    "#ffeb3b", // Yellow
    "#ffc107", // Amber
    "#ff9800", // Orange
    "#ff5722", // Deep Orange
    "#f44336", // Red
    "#e91e63", // Pink
    "#9c27b0", // Purple
    "#673ab7", // Deep Purple
    "#ffffff", // White
  ];

  // Organize tools into categories
  const navigationTools = tools.slice(0, 2); // Select and Pan
  const drawingTools = tools.slice(2, 8); // Freehand, Line, Arrow, Square, Circle, Diamond
  const textTools = tools.slice(8, 9); // Text
  const utilityTools = tools.slice(9); // Eraser

  return (
    <div className="toolbar relative p-4 bg-white border border-gray-200 rounded-xl shadow-lg flex flex-wrap items-center gap-3 mb-4 backdrop-blur-sm z-40">
      <div className="flex flex-col sm:flex-row gap-3 w-full">
        {/* Top row with tools organized by category */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Navigation tools */}
          <div className="tools-group flex items-center gap-1 mr-2 px-1 py-1 bg-gray-50 rounded-lg">
            {navigationTools.map((tool) => (
              <button
                key={tool.id}
                className={`tool-btn p-2.5 flex items-center justify-center rounded-lg transition-all ${
                  selectedTool === tool.id
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-gray-700 hover:bg-blue-50 hover:text-blue-600"
                } ${animateTool === tool.id ? "tool-selected" : ""}`}
                title={tool.label}
                onClick={() => onSelectTool(tool.id)}
              >
                {tool.icon}
                <span className="sr-only">{tool.label}</span>
              </button>
            ))}
          </div>

          {/* Drawing tools */}
          <div className="tools-group flex items-center gap-1 mr-2 px-1 py-1 bg-gray-50 rounded-lg">
            {drawingTools.map((tool) => (
              <button
                key={tool.id}
                className={`tool-btn p-2.5 flex items-center justify-center rounded-lg transition-all ${
                  selectedTool === tool.id
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-gray-700 hover:bg-blue-50 hover:text-blue-600"
                } ${animateTool === tool.id ? "tool-selected" : ""}`}
                title={tool.label}
                onClick={() => onSelectTool(tool.id)}
              >
                {tool.icon}
                <span className="sr-only">{tool.label}</span>
              </button>
            ))}
          </div>

          {/* Text tools */}
          <div className="tools-group flex items-center gap-1 mr-2 px-1 py-1 bg-gray-50 rounded-lg">
            {textTools.map((tool) => (
              <button
                key={tool.id}
                className={`tool-btn p-2.5 flex items-center justify-center rounded-lg transition-all ${
                  selectedTool === tool.id
                    ? "bg-blue-600 text-white shadow-sm"
                    : "text-gray-700 hover:bg-blue-50 hover:text-blue-600"
                } ${animateTool === tool.id ? "tool-selected" : ""}`}
                title={tool.label}
                onClick={() => onSelectTool(tool.id)}
              >
                {tool.icon}
                <span className="sr-only">{tool.label}</span>
              </button>
            ))}
          </div>

          {/* Utility tools */}
          <div className="tools-group flex items-center gap-1 mr-2 px-1 py-1 bg-gray-50 rounded-lg">
            {utilityTools.map((tool) => (
              <button
                key={tool.id}
                className={`tool-btn p-2.5 flex items-center justify-center rounded-lg transition-all ${
                  selectedTool === tool.id
                    ? "bg-red-600 text-white shadow-sm"
                    : "text-gray-700 hover:bg-red-50 hover:text-red-600"
                } ${animateTool === tool.id ? "tool-selected" : ""}`}
                title={tool.label}
                onClick={() => onSelectTool(tool.id)}
              >
                {tool.icon}
                <span className="sr-only">{tool.label}</span>
              </button>
            ))}
          </div>

          {/* Color selectors */}
          <div className="flex items-center gap-2 mr-2">
            {/* Stroke color selector */}
            <div className="relative z-40">
              <button
                className="h-10 w-10 rounded-lg border-2 flex items-center justify-center shadow-sm transition-all hover:scale-105 active:scale-95"
                style={{
                  backgroundColor: selectedColor,
                  borderColor:
                    selectedColor === "#ffffff" ? "#e2e8f0" : selectedColor,
                }}
                onClick={() => setShowColorPicker(!showColorPicker)}
                title="Stroke color"
                aria-label="Stroke color picker"
                aria-expanded={showColorPicker}
              >
                <FiDroplet
                  size={14}
                  className="text-gray-400"
                  style={{
                    opacity: selectedColor === "#ffffff" ? 1 : 0,
                  }}
                />
                {selectedColor === "#ffffff" && (
                  <div className="absolute inset-0 rounded-lg bg-gray-100 bg-opacity-20" />
                )}
              </button>

              {showColorPicker && (
                <div className="absolute top-full left-0 mt-2 p-3 bg-white border border-gray-200 rounded-xl shadow-xl z-50 w-64 animate-fadeIn">
                  <div className="flex items-center justify-between mb-2 pb-1 border-b border-gray-100">
                    <h3 className="text-xs font-medium text-gray-500">
                      Stroke Color
                    </h3>
                    <button
                      className="text-xs text-blue-500 hover:text-blue-700"
                      onClick={() => setShowColorPicker(false)}
                    >
                      Close
                    </button>
                  </div>
                  <div className="grid grid-cols-5 gap-2">
                    {colors.map((color) => (
                      <div
                        key={color}
                        className={`color-picker-item h-8 w-8 rounded-md cursor-pointer transition-all hover:scale-110 hover:shadow-md ${
                          color === selectedColor ? "ring-2 ring-blue-500" : ""
                        }`}
                        style={{
                          backgroundColor: color,
                          border:
                            color === "#ffffff" ? "1px solid #ddd" : "none",
                        }}
                        onClick={() => {
                          onSelectColor(color);
                          setShowColorPicker(false);
                        }}
                        role="button"
                        aria-label={`Select stroke color ${color}`}
                        tabIndex={0}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Unified Fill color selector */}
            <div className="relative z-40">
              <button
                className={`h-10 w-10 rounded-lg border-2 flex items-center justify-center shadow-sm transition-all hover:scale-105 active:scale-95 ${
                  activeFillColor !== "transparent"
                    ? "border-dashed shadow-inner"
                    : "border-solid"
                }`}
                style={{
                  backgroundColor: isFillTransparent
                    ? "#ffffff"
                    : activeFillColor,
                  borderColor: isFillTransparent ? "#e2e8f0" : activeFillColor,
                  background: !isFillTransparent
                    ? `repeating-linear-gradient(${
                        Math.random() * 60 + 30
                      }deg, ${activeFillColor}, ${activeFillColor} 2px, ${activeFillColor}bb 2px, ${activeFillColor}bb 5px)`
                    : "#ffffff",
                }}
                onClick={() => setShowFillColorPicker(!showFillColorPicker)}
                title={
                  hasSelectedShape
                    ? "Change selected shape's fill"
                    : "Fill color for new shapes"
                }
                aria-label="Fill color picker"
                aria-expanded={showFillColorPicker}
              >
                <div className="absolute inset-0 w-full h-full overflow-hidden rounded-lg">
                  <div className="w-full h-full rounded-lg flex items-center justify-center">
                    <FaFillDrip
                      size={14}
                      className={
                        isFillTransparent ? "text-gray-400" : "text-white"
                      }
                    />
                  </div>
                </div>
                {isFillTransparent && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-7 h-0.5 bg-red-500 rotate-45 rounded-full" />
                  </div>
                )}
              </button>

              {showFillColorPicker && (
                <div className="absolute top-full left-0 mt-2 p-3 bg-white border border-gray-200 rounded-xl shadow-xl z-50 w-64 animate-fadeIn">
                  <div className="flex items-center justify-between mb-3 pb-1 border-b border-gray-100">
                    <h3 className="text-xs font-medium text-gray-500">
                      {hasSelectedShape ? "Shape Fill Color" : "Fill Color"}
                    </h3>
                    <button
                      className="text-xs text-blue-500 hover:text-blue-700"
                      onClick={() => setShowFillColorPicker(false)}
                    >
                      Close
                    </button>
                  </div>

                  {/* Fill Style Options */}
                  <div className="mb-3">
                    <h4 className="text-xs font-medium text-gray-500 mb-2">
                      Fill Style
                    </h4>
                    <select
                      className="w-full h-9 px-2 border border-gray-200 rounded-lg cursor-pointer bg-white"
                      onChange={(e) => {
                        const selectedStyle = e.target.value;
                        const options = {
                          fillStyle: selectedStyle,
                          roughness: selectedStyle === "solid" ? 0 : 1.5,
                          fillWeight: selectedStyle === "solid" ? 1 : 0.5,
                          hachureGap:
                            selectedStyle === "hachure"
                              ? 5
                              : selectedStyle === "cross-hatch"
                              ? 6
                              : selectedStyle === "zigzag"
                              ? 7
                              : 8,
                          hachureAngle: Math.random() * 60 + 30,
                        };

                        if (hasSelectedShape && onChangeSelectedShapeFill) {
                          onChangeSelectedShapeFill(activeFillColor, options);
                        } else {
                          onSelectFillColor(activeFillColor, options);
                        }
                      }}
                      value={
                        hasSelectedShape && selectedShapeOptions?.fillStyle
                          ? selectedShapeOptions.fillStyle
                          : defaultFillStyle || "hachure"
                      }
                    >
                      <option value="hachure">Hatched</option>
                      <option value="solid">Solid</option>
                      <option value="cross-hatch">Cross-hatched</option>
                      <option value="zigzag">Zigzag</option>
                      <option value="dots">Dots</option>
                      <option value="dashed">Dashed</option>
                      <option value="zigzag-line">Zigzag Line</option>
                    </select>
                  </div>

                  {/* No Fill Option */}
                  <div
                    className={`h-9 w-full mb-3 rounded-lg cursor-pointer transition-all border border-gray-200 flex items-center justify-center hover:bg-gray-50 ${
                      isFillTransparent ? "ring-2 ring-blue-500 bg-blue-50" : ""
                    }`}
                    onClick={() => handleFillColorSelect("transparent")}
                  >
                    <div className="flex items-center">
                      <div className="relative w-4 h-4">
                        <div className="absolute w-5 h-0.5 bg-red-500 rotate-45 top-1/2 -translate-y-1/2 rounded-full" />
                      </div>
                      <span className="ml-2 text-sm font-medium text-gray-700">
                        No Fill
                      </span>
                    </div>
                  </div>

                  {/* Color Groups */}
                  <div className="space-y-2">
                    {/* Dark/Neutral Colors */}
                    <div className="grid grid-cols-6 gap-1.5">
                      {[
                        "#000000",
                        "#ffffff",
                        "#3f51b5",
                        "#673ab7",
                        "#9c27b0",
                        "#e91e63",
                      ].map((color) => (
                        <div
                          key={color}
                          className={`color-swatch h-8 w-8 rounded-md cursor-pointer transition-transform hover:scale-110 hover:shadow-md ${
                            color === activeFillColor
                              ? "ring-2 ring-blue-500 ring-offset-1"
                              : ""
                          }`}
                          style={{
                            backgroundColor: color,
                            border:
                              color === "#ffffff"
                                ? "1px solid #e2e8f0"
                                : "none",
                          }}
                          onClick={() => handleFillColorSelect(color)}
                          title={color}
                        />
                      ))}
                    </div>

                    {/* Cool Colors */}
                    <div className="grid grid-cols-6 gap-1.5">
                      {[
                        "#f44336",
                        "#ff5722",
                        "#ff9800",
                        "#ffc107",
                        "#ffeb3b",
                        "#cddc39",
                      ].map((color) => (
                        <div
                          key={color}
                          className={`color-swatch h-8 w-8 rounded-md cursor-pointer transition-transform hover:scale-110 hover:shadow-md ${
                            color === activeFillColor
                              ? "ring-2 ring-blue-500 ring-offset-1"
                              : ""
                          }`}
                          style={{
                            backgroundColor: color,
                          }}
                          onClick={() => handleFillColorSelect(color)}
                          title={color}
                        />
                      ))}
                    </div>

                    {/* Warm Colors */}
                    <div className="grid grid-cols-6 gap-1.5">
                      {[
                        "#8bc34a",
                        "#4caf50",
                        "#009688",
                        "#00bcd4",
                        "#03a9f4",
                        "#2196f3",
                      ].map((color) => (
                        <div
                          key={color}
                          className={`color-swatch h-8 w-8 rounded-md cursor-pointer transition-transform hover:scale-110 hover:shadow-md ${
                            color === activeFillColor
                              ? "ring-2 ring-blue-500 ring-offset-1"
                              : ""
                          }`}
                          style={{
                            backgroundColor: color,
                          }}
                          onClick={() => handleFillColorSelect(color)}
                          title={color}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Divider for small screens */}
        <div className="sm:hidden w-full h-px bg-gray-200 my-2"></div>

        {/* Right aligned actions */}
        <div className="flex flex-wrap items-center gap-2 ml-auto">
          {/* History controls with modern styling */}
          <div className="flex gap-1 items-center mr-2 px-1 py-1 bg-gray-50 rounded-lg">
            <button
              className={`p-2.5 rounded-lg flex items-center justify-center transition-colors ${
                canUndo
                  ? "hover:bg-blue-50 text-gray-700 hover:text-blue-600"
                  : "text-gray-300 cursor-not-allowed"
              }`}
              onClick={onUndo}
              disabled={!canUndo}
              title="Undo"
              aria-label="Undo"
            >
              <FiCornerUpLeft size={18} />
            </button>

            <button
              className={`p-2.5 rounded-lg flex items-center justify-center transition-colors ${
                canRedo
                  ? "hover:bg-blue-50 text-gray-700 hover:text-blue-600"
                  : "text-gray-300 cursor-not-allowed"
              }`}
              onClick={onRedo}
              disabled={!canRedo}
              title="Redo"
              aria-label="Redo"
            >
              <FiCornerUpRight size={18} />
            </button>

            <button
              className="p-2.5 rounded-lg hover:bg-red-50 text-red-500 flex items-center justify-center transition-colors"
              onClick={onClearCanvas}
              title="Clear canvas"
              aria-label="Clear canvas"
            >
              <FiTrash2 size={18} />
            </button>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3">
            <button
              className="h-9 px-4 rounded-lg bg-gradient-to-r from-blue-600 to-blue-700 text-white flex items-center gap-2 transition-all hover:translate-y-[-1px] hover:shadow-md active:translate-y-[1px]"
              onClick={onSave}
              title="Save as image"
              aria-label="Save as image"
            >
              <FiDownload size={15} />
              <span className="text-sm font-medium hidden sm:inline">Save</span>
            </button>

            {onGenerateLink && (
              <div className="relative">
                <button
                  className="h-9 px-4 rounded-lg bg-gradient-to-r from-emerald-600 to-emerald-700 text-white flex items-center gap-2 transition-all hover:translate-y-[-1px] hover:shadow-md active:translate-y-[1px]"
                  onClick={onGenerateLink}
                  title="Share link"
                  aria-label="Share link"
                >
                  <FiLink size={15} />
                  <span className="text-sm font-medium hidden sm:inline">
                    Share
                  </span>
                </button>
                {showLinkCopied && (
                  <div className="absolute -top-8 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-black/90 text-white text-xs font-medium rounded-lg shadow-lg backdrop-blur-sm">
                    Link copied
                  </div>
                )}
              </div>
            )}

            {toggleUserPanel && (
              <button
                className="h-9 px-4 rounded-lg bg-gradient-to-r from-purple-600 to-purple-700 text-white flex items-center gap-2 transition-all hover:translate-y-[-1px] hover:shadow-md active:translate-y-[1px]"
                onClick={toggleUserPanel}
                title="Users"
                aria-label="Toggle users panel"
              >
                <FiUsers size={15} />
                <span className="text-sm font-medium hidden sm:inline">
                  Users
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Toolbar;

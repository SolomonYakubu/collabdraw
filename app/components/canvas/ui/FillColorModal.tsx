import React, { useState, useEffect } from "react";

interface FillColorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectColor: (color: string) => void;
  initialColor: string;
}

const FillColorModal: React.FC<FillColorModalProps> = ({
  isOpen,
  onClose,
  onSelectColor,
  initialColor = "transparent",
}) => {
  const [selectedColor, setSelectedColor] = useState<string>(initialColor);

  useEffect(() => {
    setSelectedColor(initialColor);
  }, [initialColor, isOpen]);

  const colors = [
    "transparent", // No fill
    "#000000", // Black
    "#3f51b5", // Indigo
    "#2196f3", // Blue
    "#03a9f4", // Light Blue
    "#00bcd4", // Cyan
    "#4caf50", // Green
    "#8bc34a", // Light Green
    "#ffeb3b", // Yellow
    "#ff9800", // Orange
    "#f44336", // Red
    "#e91e63", // Pink
    "#9c27b0", // Purple
    "#ffffff", // White
  ];

  const handleSelectColor = (color: string) => {
    setSelectedColor(color);
    onSelectColor(color);
    onClose();
  };

  if (!isOpen) return null;

  const isFillTransparent =
    selectedColor === "transparent" || selectedColor === "none";

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div
        className="fixed inset-0 bg-black bg-opacity-30"
        onClick={onClose}
      ></div>
      <div
        className="bg-white rounded-lg shadow-xl p-4 z-50 w-64 animate-fadeIn"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-2">
          <h3 className="text-base font-medium">Fill Color</h3>
          <button
            className="text-gray-500 hover:text-gray-700 text-xl"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="mb-2">
          <div
            className={`h-8 w-full mb-2 rounded-lg cursor-pointer border border-gray-300 flex items-center justify-center ${
              isFillTransparent ? "ring-2 ring-blue-500" : ""
            }`}
            onClick={() => handleSelectColor("transparent")}
          >
            <div className="flex items-center">
              <div className="w-4 h-0.5 bg-red-500 rotate-45 rounded-full" />
              <span className="ml-2 text-sm">No Fill</span>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-2">
            {colors.slice(1).map((color) => (
              <div
                key={color}
                className={`h-8 w-8 rounded-md cursor-pointer hover:scale-110 ${
                  color === selectedColor ? "ring-2 ring-blue-500" : ""
                }`}
                style={{
                  backgroundColor: color,
                  border: color === "#ffffff" ? "1px solid #ddd" : "none",
                }}
                onClick={() => handleSelectColor(color)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default FillColorModal;

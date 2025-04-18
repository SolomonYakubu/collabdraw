import React, { useEffect, useState, useRef } from "react";
import {
  FiCopy,
  FiTrash2,
  FiClipboard,
  FiZoomIn,
  FiBold,
  FiAlignCenter,
  FiLayers,
  FiDroplet,
  FiArrowUp,
  FiArrowDown,
  FiChevronUp,
  FiChevronDown,
} from "react-icons/fi";

interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onDelete: () => void;
  onDuplicate?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  onBringForward?: () => void;
  onSendBackward?: () => void;
  onBringToFront?: () => void;
  onSendToBack?: () => void;
  onGroupItems?: () => void;
  onUngroupItems?: () => void;
  onChangeFillColor?: () => void;
  isShapeSelected: boolean;
  isMultipleSelection: boolean;
}

const ContextMenu: React.FC<ContextMenuProps> = ({
  x,
  y,
  onClose,
  onDelete,
  onDuplicate,
  onCopy,
  onPaste,
  onBringForward,
  onSendBackward,
  onBringToFront,
  onSendToBack,
  onGroupItems,
  onUngroupItems,
  onChangeFillColor,
  isShapeSelected,
  isMultipleSelection,
}) => {
  const [showLayerSubmenu, setShowLayerSubmenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Check if menu would go off screen and adjust position
  const adjustPosition = () => {
    if (!menuRef.current) return { x, y };

    const rect = menuRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let adjustedX = x;
    let adjustedY = y;

    if (x + rect.width > viewportWidth) {
      adjustedX = viewportWidth - rect.width - 10;
    }

    if (y + rect.height > viewportHeight) {
      adjustedY = viewportHeight - rect.height - 10;
    }

    return { x: adjustedX, y: adjustedY };
  };

  const position = adjustPosition();

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener("click", handleClickOutside);
    document.addEventListener("contextmenu", handleClickOutside);

    return () => {
      document.removeEventListener("click", handleClickOutside);
      document.removeEventListener("contextmenu", handleClickOutside);
    };
  }, [onClose]);

  // Prevent default context menu
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    document.addEventListener("contextmenu", handleContextMenu);
    return () => {
      document.removeEventListener("contextmenu", handleContextMenu);
    };
  }, []);

  const hasLayerOptions =
    onBringForward || onSendBackward || onBringToFront || onSendToBack;

  // Handle layer submenu clicks
  const handleLayerAction = (action: () => void) => {
    action();
    setShowLayerSubmenu(false);
  };

  return (
    <div
      ref={menuRef}
      className="fixed bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50"
      style={{
        left: position.x,
        top: position.y,
        minWidth: "180px",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {isShapeSelected && (
        <>
          {onCopy && (
            <button
              className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2"
              onClick={onCopy}
            >
              <FiCopy size={14} />
              Copy
            </button>
          )}
          {onDuplicate && (
            <button
              className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2"
              onClick={onDuplicate}
            >
              <FiCopy size={14} />
              Duplicate
            </button>
          )}
          <button
            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2"
            onClick={onDelete}
          >
            <FiTrash2 size={14} />
            Delete
          </button>

          {/* Layer management section */}
          {hasLayerOptions && (
            <div className="relative">
              <button
                className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center justify-between"
                onClick={() => setShowLayerSubmenu(!showLayerSubmenu)}
              >
                <div className="flex items-center gap-2">
                  <FiLayers size={14} />
                  Layer
                </div>
                <FiChevronDown
                  size={14}
                  className={
                    showLayerSubmenu
                      ? "rotate-180 transition-transform"
                      : "transition-transform"
                  }
                />
              </button>

              {showLayerSubmenu && (
                <div className="absolute z-50 w-full">
                  <div className="bg-white rounded-lg shadow-lg border border-gray-200 mt-1 py-1 w-48">
                    {onBringToFront && (
                      <button
                        className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2"
                        onClick={() => handleLayerAction(onBringToFront)}
                      >
                        <FiArrowUp size={14} />
                        Bring to Front
                      </button>
                    )}
                    {onBringForward && (
                      <button
                        className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2"
                        onClick={() => handleLayerAction(onBringForward)}
                      >
                        <FiChevronUp size={14} />
                        Bring Forward
                      </button>
                    )}
                    {onSendBackward && (
                      <button
                        className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2"
                        onClick={() => handleLayerAction(onSendBackward)}
                      >
                        <FiChevronDown size={14} />
                        Send Backward
                      </button>
                    )}
                    {onSendToBack && (
                      <button
                        className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2"
                        onClick={() => handleLayerAction(onSendToBack)}
                      >
                        <FiArrowDown size={14} />
                        Send to Back
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Group management */}
          {isMultipleSelection && onGroupItems && (
            <button
              className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2"
              onClick={onGroupItems}
            >
              <FiAlignCenter size={14} />
              Group
            </button>
          )}
          {!isMultipleSelection && onUngroupItems && (
            <button
              className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2"
              onClick={onUngroupItems}
            >
              <FiBold size={14} />
              Ungroup
            </button>
          )}
          {onChangeFillColor && (
            <button
              className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2"
              onClick={onChangeFillColor}
            >
              <FiDroplet size={14} />
              Change Fill Color
            </button>
          )}
        </>
      )}
      {onPaste && (
        <button
          className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2"
          onClick={onPaste}
        >
          <FiClipboard size={14} />
          Paste
        </button>
      )}
    </div>
  );
};

export default ContextMenu;

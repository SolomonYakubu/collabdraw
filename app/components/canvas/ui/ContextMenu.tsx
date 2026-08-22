"use client";

/**
 * Canvas context menu.
 *
 * The previous version measured itself during render through a ref that was
 * still null, so the off-screen adjustment never actually ran, and it installed
 * a document-wide `contextmenu` preventDefault that outlived its usefulness.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ContextMenuItem {
  label: string;
  shortcut?: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Renders a divider above this item. */
  separatorBefore?: boolean;
}

interface ContextMenuProps {
  /** Position relative to the containing element. */
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  // Measure after mount, then nudge back inside the viewport if needed.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) {
      return;
    }

    const rect = menu.getBoundingClientRect();
    const parent = menu.offsetParent?.getBoundingClientRect();
    const maxX = (parent?.width ?? window.innerWidth) - rect.width - 8;
    const maxY = (parent?.height ?? window.innerHeight) - rect.height - 8;

    setPosition({
      x: Math.max(8, Math.min(x, maxX)),
      y: Math.max(8, Math.min(y, maxY)),
    });
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    // Scrolling or zooming the canvas should dismiss it too.
    window.addEventListener("wheel", onClose, { passive: true });

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("wheel", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      role="menu"
      className="island absolute z-50 min-w-52 py-1"
      style={{ left: position.x, top: position.y }}
    >
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`}>
          {item.separatorBefore && index > 0 && (
            <div className="divider my-1 h-px" />
          )}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
            className="flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left text-sm transition-colors"
            style={{
              color: item.disabled
                ? "var(--text-faint)"
                : item.danger
                  ? "var(--danger)"
                  : "var(--text)",
              cursor: item.disabled ? "not-allowed" : undefined,
              background: "transparent",
            }}
            onMouseEnter={(event) => {
              if (!item.disabled) {
                event.currentTarget.style.background = item.danger
                  ? "var(--danger-bg)"
                  : "var(--hover-bg)";
              }
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = "transparent";
            }}
          >
            {item.label}
            {item.shortcut && (
              <span className="text-xs" style={{ color: "var(--text-faint)" }}>
                {item.shortcut}
              </span>
            )}
          </button>
        </div>
      ))}
    </div>
  );
};

export default ContextMenu;

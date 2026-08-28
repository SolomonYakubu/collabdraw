"use client";

/**
 * Main menu — the "options" surface.
 *
 * Excalidraw puts the document-level actions (open, save, export, start a
 * collaboration room, reset) behind a hamburger at the top-left, keeping the
 * tool island for drawing only. Same split here, and the same item list is
 * rendered by the mobile drawer in `MobileHeader`, so there is one definition
 * of "what is in the menu" instead of two that drift.
 */
import { useEffect, useRef, useState } from "react";
import { FiMenu, FiX } from "react-icons/fi";

export interface MainMenuItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
  /** Right-aligned muted value, e.g. the current theme or "On" / "Off". */
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  /** Renders a divider above this item. */
  separatorBefore?: boolean;
}

/** Shared item renderer, used by the desktop popover and the mobile drawer. */
export const MainMenuList: React.FC<{
  items: MainMenuItem[];
  onAfterSelect?: () => void;
}> = ({ items, onAfterSelect }) => (
  <div role="menu" className="flex flex-col">
    {items.map((item, index) => (
      <div key={item.id}>
        {item.separatorBefore && index > 0 && (
          <div className="divider my-1 h-px" />
        )}
        <button
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            item.onSelect();
            onAfterSelect?.();
          }}
          className="flex w-full items-center justify-between gap-6 rounded-lg px-3 py-2 text-left text-sm transition-colors"
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
          <span className="flex items-center gap-3">
            <span aria-hidden="true" className="flex w-4 justify-center">
              {item.icon}
            </span>
            {item.label}
          </span>
          {item.hint && (
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              {item.hint}
            </span>
          )}
        </button>
      </div>
    ))}
  </div>
);

/** Desktop hamburger island with a popover. */
const MainMenu: React.FC<{ items: MainMenuItem[] }> = ({ items }) => {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={rootRef} className="pointer-events-auto relative">
      <div className="island p-1 md:p-1.5">
        <button
          type="button"
          onClick={() => setIsOpen((open) => !open)}
          className="island-button h-9 w-9"
          aria-label="Main menu"
          aria-haspopup="menu"
          aria-expanded={isOpen}
          data-active={isOpen ? "true" : undefined}
        >
          {isOpen ? <FiX size={17} /> : <FiMenu size={17} />}
        </button>
      </div>

      {isOpen && (
        <div className="island absolute left-0 top-full z-50 mt-2 min-w-60 p-1.5">
          <MainMenuList items={items} onAfterSelect={() => setIsOpen(false)} />
        </div>
      )}
    </div>
  );
};

export default MainMenu;


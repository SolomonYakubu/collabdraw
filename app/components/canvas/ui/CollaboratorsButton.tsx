"use client";

/**
 * Who is in the room — the people button in the tool island, with the list
 * hanging off it.
 *
 * The list is *only* reachable through this button: there is no standing panel
 * on the canvas. It owns its own open state, so the toolbar stays presentational
 * and nothing above it re-renders on a click.
 *
 * The panel is portalled to `document.body` and positioned from the button's
 * rect rather than nested inside it, because the tool island is a horizontal
 * scroll container (`overflow-x-auto`) and would clip an absolutely positioned
 * child.
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiUsers } from "react-icons/fi";

export interface Collaborator {
  id: string;
  tag: string;
}

export interface CollaboratorsButtonProps {
  users: Collaborator[];
  currentUserId?: string | null;
  /** Where the panel sits relative to the button. */
  align?: "left" | "right";
}

const PANEL_WIDTH = 192;
const GAP = 8;

const CollaboratorsButton: React.FC<CollaboratorsButtonProps> = ({
  users,
  currentUserId,
  align = "right",
}) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  );

  const close = useCallback(() => setAnchor(null), []);

  const toggle = useCallback(() => {
    setAnchor((current) => {
      if (current) {
        return null;
      }
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) {
        return null;
      }
      const preferred =
        align === "right" ? rect.right - PANEL_WIDTH : rect.left;
      return {
        top: rect.bottom + GAP,
        // Keep the panel on screen whichever edge the button sits near.
        left: Math.max(
          GAP,
          Math.min(preferred, window.innerWidth - PANEL_WIDTH - GAP),
        ),
      };
    });
  }, [align]);

  const isOpen = anchor !== null;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !panelRef.current?.contains(target) &&
        !buttonRef.current?.contains(target)
      ) {
        close();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", close);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
    };
  }, [close, isOpen]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        title="Collaborators"
        aria-label="Collaborators"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        data-active={isOpen ? "true" : undefined}
        onClick={toggle}
        className="island-button h-9 min-w-9 shrink-0 gap-1 px-2 text-[12px] font-medium"
      >
        <FiUsers size={15} />
        {users.length > 0 && users.length}
      </button>

      {anchor &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            aria-label="Collaborators"
            className="island fixed z-50 p-2"
            style={{
              top: anchor.top,
              left: anchor.left,
              width: PANEL_WIDTH,
            }}
          >
            {users.length === 0 ? (
              <p
                className="px-1 py-0.5 text-xs"
                style={{ color: "var(--text-muted)" }}
              >
                Nobody else is here yet.
              </p>
            ) : (
              <ul className="flex flex-col">
                {users.map((user) => (
                  <li
                    key={user.id}
                    className="flex items-center gap-2 px-1 py-1 text-xs"
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: "var(--success)" }}
                    />
                    <span className="truncate">{user.tag}</span>
                    {user.id === currentUserId && (
                      <span
                        className="shrink-0"
                        style={{ color: "var(--text-faint)" }}
                      >
                        (you)
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>,
          document.body,
        )}
    </>
  );
};

export default memo(CollaboratorsButton);

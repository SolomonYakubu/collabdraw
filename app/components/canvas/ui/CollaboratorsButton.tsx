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

import { MAX_USER_NAME_LENGTH } from "../../../services/collaboration/identity";

export interface Collaborator {
  id: string;
  tag: string;
}

export interface CollaboratorsButtonProps {
  users: Collaborator[];
  currentUserId?: string | null;
  /** Your own display name, seeding the editable field. */
  userName?: string;
  /**
   * Commit a new display name. Returns false when the input held nothing
   * usable, in which case the field falls back to the name you had.
   */
  onRenameUser?: (value: string) => boolean;
  /** Where the panel sits relative to the button. */
  align?: "left" | "right";
}

const PANEL_WIDTH = 216;
const GAP = 8;

/**
 * Your own row, as an editable field.
 *
 * This is where a name belongs: the panel is already the answer to "who is in
 * this room", so it is also the obvious place to fix the answer it gives about
 * you. Commits on Enter and on blur; Escape puts back the name you had.
 */
const NameField: React.FC<{
  userName: string;
  onRenameUser: (value: string) => boolean;
}> = ({ userName, onRenameUser }) => {
  const [draft, setDraft] = useState(userName);
  const isMountedRef = useRef(true);

  // Follow the stored name whenever it changes underneath — another tab, or the
  // menu's rename dialog.
  useEffect(() => setDraft(userName), [userName]);

  const commit = useCallback(() => {
    if (draft === userName) {
      return;
    }
    if (!onRenameUser(draft) && isMountedRef.current) {
      setDraft(userName);
    }
  }, [draft, onRenameUser, userName]);

  /*
   * Closing the panel by clicking away unmounts this field before `blur` can
   * fire, so the last thing typed would be thrown away. Commit on the way out
   * instead: a ref, because the cleanup has to run once with whatever `commit`
   * was current, not on every keystroke.
   */
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(
    () => () => {
      isMountedRef.current = false;
      commitRef.current();
    },
    [],
  );

  return (
    <div className="mb-1 flex flex-col gap-1 px-1 pb-2 pt-0.5">
      <label
        htmlFor="collab-user-name"
        className="text-[11px] font-medium"
        style={{ color: "var(--text-muted)" }}
      >
        Your name
      </label>
      <input
        id="collab-user-name"
        value={draft}
        maxLength={MAX_USER_NAME_LENGTH}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            // Swallow it, or the panel's own handler would close the whole
            // thing on what the user meant as "undo my typing".
            event.stopPropagation();
            setDraft(userName);
          }
        }}
        className="field h-8 w-full px-2 text-xs"
      />
    </div>
  );
};

const CollaboratorsButton: React.FC<CollaboratorsButtonProps> = ({
  users,
  currentUserId,
  userName,
  onRenameUser,
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
        aria-haspopup="true"
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
            aria-label="Collaborators"
            className="island fixed z-50 p-2"
            style={{
              top: anchor.top,
              left: anchor.left,
              width: PANEL_WIDTH,
            }}
          >
            {/* Not a `role="menu"` any more: it holds a text field, and a menu
                may only contain menu items. */}
            {onRenameUser && (
              <NameField
                userName={userName ?? ""}
                onRenameUser={onRenameUser}
              />
            )}

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

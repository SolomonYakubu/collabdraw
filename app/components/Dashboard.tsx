"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FiAlertTriangle,
  FiArrowRight,
  FiEdit2,
  FiLayers,
  FiLink,
  FiMonitor,
  FiMoon,
  FiMoreHorizontal,
  FiSearch,
  FiSun,
  FiTrash2,
  FiX,
} from "react-icons/fi";

import { useTheme } from "../hooks/useTheme";
import type { BoardSummary } from "../lib/db";
import ConfirmDialog from "./ui/ConfirmDialog";
import PromptDialog from "./ui/PromptDialog";
import ToastStack, { useToasts } from "./ui/Toast";

interface DashboardProps {
  boards: BoardSummary[];
  /** The board store could not be reached — say so instead of showing "empty". */
  unavailable?: boolean;
}

/** A search field only earns its space once scanning the grid gets slow. */
const SEARCH_THRESHOLD = 4;

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Lazily fetched board preview.
 *
 * Three states, and they look different on purpose: a shimmer while the request
 * is out, the drawing itself, or squared paper for a board with no thumbnail yet.
 * Collapsing the last two into one "No preview" label made a loading gallery look
 * like an empty one.
 */
function Thumb({ boardId }: { boardId: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/boards/${boardId}/thumbnail`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setDataUrl(d?.dataUrl ?? null);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  return (
    <div
      className={`relative overflow-hidden ${dataUrl ? "" : "dot-grid"}`}
      style={{
        aspectRatio: "16 / 10",
        background: "var(--field-bg)",
        borderBottom: "1px solid var(--divider)",
      }}
    >
      {dataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={dataUrl}
          alt=""
          className="board-card__preview h-full w-full object-cover"
        />
      ) : loading ? (
        <div className="skeleton absolute inset-0" />
      ) : (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-1.5"
          style={{ color: "var(--text-faint)" }}
        >
          <FiLayers size={20} aria-hidden="true" />
          <span className="text-xs">Not previewed yet</span>
        </div>
      )}
    </div>
  );
}

interface MenuAction {
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
  danger?: boolean;
}

/**
 * The per-card action menu.
 *
 * Deliberately always visible rather than revealed on hover: a touch device never
 * hovers, so a hover-only control would put rename and delete out of reach.
 */
function CardMenu({
  label,
  actions,
}: {
  label: string;
  actions: MenuAction[];
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        className="island-button card-action h-7 w-7"
        aria-label={`Actions for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <FiMoreHorizontal size={15} />
      </button>

      {open && (
        <div
          role="menu"
          className="island animate-dialog-in absolute right-0 top-9 z-10 w-40 p-1"
        >
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              role="menuitem"
              className={`menu-item${action.danger ? " menu-item--danger" : ""}`}
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
            >
              <span aria-hidden="true" className="shrink-0">
                {action.icon}
              </span>
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Light / dark / follow-the-system, the same cycle the canvas toolbar offers. */
function ThemeButton() {
  const { preference, cycle } = useTheme();
  const icon =
    preference === "light" ? (
      <FiSun size={16} />
    ) : preference === "dark" ? (
      <FiMoon size={16} />
    ) : (
      <FiMonitor size={16} />
    );

  return (
    <button
      type="button"
      onClick={cycle}
      className="island-button h-9 w-9"
      aria-label={`Theme: ${preference}. Click to change.`}
      title={`Theme: ${preference}`}
    >
      {icon}
    </button>
  );
}

export default function Dashboard({
  boards: initialBoards,
  unavailable = false,
}: DashboardProps) {
  const [boards, setBoards] = useState(initialBoards);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** The board a dialog is asking about, and what it is asking. */
  const [pending, setPending] = useState<{
    action: "rename" | "delete";
    id: string;
    title: string;
  } | null>(null);
  const { toasts, show: showToast, dismiss: dismissToast } = useToasts();

  useEffect(() => setBoards(initialBoards), [initialBoards]);

  const rename = useCallback(
    async (title: string) => {
      const target = pending;
      setPending(null);
      if (!target || title === target.title) {
        return;
      }
      setBusyId(target.id);
      try {
        const response = await fetch(`/api/boards/${target.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title }),
        });
        if (!response.ok) {
          throw new Error(`Rename failed (${response.status})`);
        }
        setBoards((prev) =>
          prev.map((b) => (b.id === target.id ? { ...b, title } : b)),
        );
        showToast("Board renamed", { kind: "success", id: "rename" });
      } catch {
        showToast("Could not rename that board.", {
          kind: "error",
          id: "rename",
        });
      } finally {
        setBusyId(null);
      }
    },
    [pending, showToast],
  );

  const remove = useCallback(async () => {
    const target = pending;
    setPending(null);
    if (!target) {
      return;
    }
    setBusyId(target.id);
    try {
      const response = await fetch(`/api/boards/${target.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(`Delete failed (${response.status})`);
      }
      setBoards((prev) => prev.filter((b) => b.id !== target.id));
      showToast(`Deleted “${target.title}”`, {
        kind: "success",
        id: "delete",
      });
    } catch {
      showToast("Could not delete that board.", {
        kind: "error",
        id: "delete",
      });
    } finally {
      setBusyId(null);
    }
  }, [pending, showToast]);

  const copyLink = useCallback(
    async (id: string) => {
      const url = `${window.location.origin}/board/${id}`;
      try {
        await navigator.clipboard.writeText(url);
        showToast("Link copied", { kind: "success", id: "copy-link" });
      } catch {
        // Clipboard access is denied on insecure origins and by some browsers.
        showToast("Could not copy that link.", {
          kind: "error",
          id: "copy-link",
        });
      }
    },
    [showToast],
  );

  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      needle
        ? boards.filter((board) => board.title.toLowerCase().includes(needle))
        : boards,
    [boards, needle],
  );

  const isEmpty = boards.length === 0;

  const cards = useMemo(
    () =>
      visible.map((board) => (
        <article
          key={board.id}
          className="board-card relative flex flex-col overflow-hidden"
          style={{
            opacity: busyId === board.id ? 0.5 : 1,
            pointerEvents: busyId === board.id ? "none" : undefined,
          }}
        >
          <Link
            href={`/board/${board.id}`}
            className="flex flex-1 flex-col outline-none"
            aria-label={`Open ${board.title}`}
          >
            <Thumb boardId={board.id} />
            <div className="flex flex-col gap-1 p-3">
              <span
                className="truncate pr-8 text-sm font-semibold"
                style={{ color: "var(--text)" }}
              >
                {board.title}
              </span>
              <span
                className="flex items-center gap-1.5 text-xs"
                style={{ color: "var(--text-muted)" }}
              >
                <FiLayers size={11} aria-hidden="true" />
                {board.element_count} item{board.element_count === 1 ? "" : "s"}
                <span aria-hidden="true">·</span>
                {timeAgo(board.last_opened_at ?? board.updated_at)}
              </span>
            </div>
          </Link>

          <div className="absolute right-2 top-2">
            <CardMenu
              label={board.title}
              actions={[
                {
                  label: "Rename",
                  icon: <FiEdit2 size={13} />,
                  onSelect: () =>
                    setPending({
                      action: "rename",
                      id: board.id,
                      title: board.title,
                    }),
                },
                {
                  label: "Copy link",
                  icon: <FiLink size={13} />,
                  onSelect: () => void copyLink(board.id),
                },
                {
                  label: "Delete",
                  icon: <FiTrash2 size={13} />,
                  danger: true,
                  onSelect: () =>
                    setPending({
                      action: "delete",
                      id: board.id,
                      title: board.title,
                    }),
                },
              ]}
            />
          </div>
        </article>
      )),
    [visible, busyId, copyLink],
  );

  return (
    <div className="gallery thin-scroll fixed inset-0 overflow-y-auto">
      <header className="sticky-bar sticky top-0 z-30">
        <div className="mx-auto flex h-14 max-w-[1180px] items-center justify-between gap-4 px-6">
          <Link href="/" className="flex items-center gap-2.5 outline-none">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="" width={26} height={26} />
            <span
              className="text-sm font-semibold tracking-tight"
              style={{ color: "var(--text)" }}
            >
              CollabDraw
            </span>
          </Link>
          <div className="flex items-center gap-1.5">
            <ThemeButton />
            <Link href="/" className="btn btn--primary">
              Open canvas
              <FiArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1180px] px-6 pb-20 pt-10">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1
              className="m-0 text-[1.75rem] font-bold tracking-tight"
              style={{ color: "var(--text)" }}
            >
              Your boards
            </h1>
            <p className="mt-1.5 mb-0 text-sm" style={{ color: "var(--text-muted)" }}>
              {isEmpty
                ? "Boards you save from the canvas show up here."
                : `${boards.length} board${boards.length === 1 ? "" : "s"} saved on this device.`}
            </p>
          </div>

          {boards.length >= SEARCH_THRESHOLD && (
            <div
              className="field flex h-9 w-full max-w-64 items-center gap-2 px-2.5"
              style={{ color: "var(--text-faint)" }}
            >
              <FiSearch size={14} aria-hidden="true" className="shrink-0" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search boards"
                aria-label="Search boards"
                className="w-full bg-transparent text-sm outline-none"
                style={{ color: "var(--text)" }}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="island-button h-5 w-5 shrink-0"
                >
                  <FiX size={12} />
                </button>
              )}
            </div>
          )}
        </div>

        {unavailable && (
          <div
            className="mb-6 flex items-start gap-3 rounded-xl px-4 py-3 text-sm"
            style={{
              border: "1px solid var(--danger)",
              background: "var(--danger-bg)",
              color: "var(--danger)",
            }}
          >
            <FiAlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
            <p className="m-0">
              Saved boards are unavailable right now — the board store could not
              be reached. Your canvas still works; it is kept in this browser
              until saving comes back.
            </p>
          </div>
        )}

        {isEmpty ? (
          <EmptyState />
        ) : visible.length === 0 ? (
          <p
            className="py-16 text-center text-sm"
            style={{ color: "var(--text-muted)" }}
          >
            No board matches “{query.trim()}”.
          </p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-5">
            {cards}
          </div>
        )}
      </div>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <PromptDialog
        open={pending?.action === "rename"}
        title="Board title"
        initialValue={pending?.title ?? ""}
        confirmLabel="Rename"
        onConfirm={(title) => void rename(title)}
        onCancel={() => setPending(null)}
      />

      <ConfirmDialog
        open={pending?.action === "delete"}
        title="Delete this board?"
        description={
          pending
            ? `“${pending.title}” and its drawing are removed for good. This cannot be undone.`
            : undefined
        }
        confirmLabel="Delete"
        danger
        onConfirm={() => void remove()}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

/**
 * Nothing saved yet. The sketch is inline SVG rather than an asset so it inherits
 * the theme's accent and needs no network round trip.
 */
function EmptyState() {
  return (
    <div
      className="dot-grid flex flex-col items-center gap-5 rounded-2xl px-6 py-16 text-center"
      style={{ border: "1px dashed var(--field-border)" }}
    >
      <svg
        width="96"
        height="72"
        viewBox="0 0 96 72"
        fill="none"
        aria-hidden="true"
        style={{ color: "var(--accent)" }}
      >
        <rect
          x="8"
          y="14"
          width="34"
          height="24"
          rx="4"
          stroke="currentColor"
          strokeWidth="2"
          opacity="0.65"
        />
        <circle
          cx="70"
          cy="26"
          r="13"
          stroke="currentColor"
          strokeWidth="2"
          opacity="0.45"
        />
        <path
          d="M14 58c8-12 18-12 26-2s18 8 26-6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.8"
        />
      </svg>

      <div className="flex flex-col gap-1.5">
        <p className="m-0 text-base font-semibold" style={{ color: "var(--text)" }}>
          No saved boards yet
        </p>
        <p className="m-0 text-sm" style={{ color: "var(--text-muted)" }}>
          Draw something on the canvas, then choose{" "}
          <strong style={{ color: "var(--text)" }}>Save to my boards</strong> in
          the menu.
        </p>
      </div>

      <Link href="/" className="btn btn--primary">
        Open canvas
        <FiArrowRight size={15} aria-hidden="true" />
      </Link>
    </div>
  );
}

"use client";

import React, { memo } from "react";
import {
  FiCheck,
  FiCornerUpLeft,
  FiCornerUpRight,
  FiDownload,
  FiLink,
  FiLock,
  FiMenu,
  FiMonitor,
  FiMoon,
  FiSun,
  FiTrash2,
  FiUnlock,
  FiUsers,
  FiX,
} from "react-icons/fi";
import { RiSparkling2Line } from "react-icons/ri";
import type { ThemePreference } from "../../../hooks/useTheme";

export interface MobileHeaderProps {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onClear: () => void;
  onExport: () => void;
  onShare?: () => void;
  linkCopied?: boolean;
  isCollaborative?: boolean;
  isConnected?: boolean;
  users?: Array<{ id: string; tag: string }>;
  currentUserId?: string | null;
  onToggleAI?: () => void;
  isAIPanelOpen?: boolean;
  isAiGenerating?: boolean;
  aiConversationCount?: number;
  themePreference: ThemePreference;
  onCycleTheme: () => void;
  toolLocked: boolean;
  onToggleToolLock: () => void;
  isMenuOpen: boolean;
  onToggleMenu: () => void;
}

const THEME_LABELS: Record<ThemePreference, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

const THEME_ICONS: Record<ThemePreference, React.ReactNode> = {
  light: <FiSun size={15} />,
  dark: <FiMoon size={15} />,
  system: <FiMonitor size={15} />,
};

const MobileHeader: React.FC<MobileHeaderProps> = ({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClear,
  onExport,
  onShare,
  linkCopied,
  isCollaborative = false,
  isConnected = false,
  users = [],
  currentUserId,
  onToggleAI,
  isAIPanelOpen = false,
  isAiGenerating = false,
  aiConversationCount = 0,
  themePreference,
  onCycleTheme,
  toolLocked,
  onToggleToolLock,
  isMenuOpen,
  onToggleMenu,
}) => {
  return (
    <>
      {/* Top mobile navigation bar */}
      <header
        className="pointer-events-none fixed inset-x-2 top-2 z-30 flex items-center justify-between md:hidden"
        style={{ top: "max(0.5rem, env(safe-area-inset-top, 0.5rem))" }}
      >
        {/* Left: Hamburger menu & Live status */}
        <div className="island pointer-events-auto flex items-center gap-1 p-1 shadow-md">
          <button
            type="button"
            onClick={onToggleMenu}
            className="island-button h-9 w-9"
            aria-label="Open main menu"
            aria-expanded={isMenuOpen}
          >
            {isMenuOpen ? <FiX size={18} /> : <FiMenu size={18} />}
          </button>

          {isCollaborative && (
            <div
              className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium"
              style={{
                color: isConnected ? "var(--success)" : "var(--text-faint)",
              }}
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{
                  background: isConnected
                    ? "var(--success)"
                    : "var(--text-faint)",
                }}
              />
              {isConnected ? `${users.length}` : "Off"}
            </div>
          )}
        </div>

        {/* Right: Actions (Undo, Redo, AI, Share) */}
        <div className="island pointer-events-auto flex items-center gap-0.5 p-1 shadow-md">
          <button
            type="button"
            onClick={onUndo}
            disabled={!canUndo}
            className="island-button h-9 w-9"
            aria-label="Undo"
          >
            <FiCornerUpLeft size={16} />
          </button>

          <button
            type="button"
            onClick={onRedo}
            disabled={!canRedo}
            className="island-button h-9 w-9"
            aria-label="Redo"
          >
            <FiCornerUpRight size={16} />
          </button>

          {onToggleAI && (
            <button
              type="button"
              onClick={onToggleAI}
              aria-label="Assistant"
              aria-pressed={isAIPanelOpen}
              data-active={isAIPanelOpen ? "true" : undefined}
              className="island-button relative h-9 w-9"
            >
              {isAiGenerating ? (
                <span
                  className="h-4 w-4 animate-spin rounded-full border-2 border-current"
                  style={{ borderTopColor: "transparent" }}
                />
              ) : (
                <RiSparkling2Line size={16} />
              )}
              {aiConversationCount > 0 && !isAiGenerating && (
                <span
                  className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full"
                  style={{ background: "var(--accent)" }}
                />
              )}
            </button>
          )}

          {onShare && (
            <button
              type="button"
              onClick={onShare}
              aria-label={linkCopied ? "Link copied" : "Share link"}
              data-active={linkCopied ? "true" : undefined}
              className="island-button h-9 w-9"
            >
              {linkCopied ? <FiCheck size={16} /> : <FiLink size={16} />}
            </button>
          )}
        </div>
      </header>

      {/* Main menu modal drawer */}
      {isMenuOpen && (
        <div className="fixed inset-0 z-50 flex flex-col md:hidden">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-xs transition-opacity"
            onClick={onToggleMenu}
          />

          {/* Drawer content */}
          <div
            className="island animate-slide-up relative m-2 mt-auto max-h-[80vh] overflow-y-auto p-4 shadow-2xl"
            style={{ marginBottom: "max(1rem, env(safe-area-inset-bottom, 1rem))" }}
          >
            <div className="mb-3 flex items-center justify-between border-b pb-2" style={{ borderColor: "var(--divider)" }}>
              <span className="text-sm font-semibold">Menu</span>
              <button
                type="button"
                onClick={onToggleMenu}
                className="island-button h-8 w-8"
                aria-label="Close menu"
              >
                <FiX size={16} />
              </button>
            </div>

            <div className="space-y-2">
              {/* Export */}
              <button
                type="button"
                onClick={() => {
                  onExport();
                  onToggleMenu();
                }}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors hover:bg-[var(--hover-bg)]"
              >
                <FiDownload size={16} />
                <span>Export as PNG</span>
              </button>

              {/* Theme switcher */}
              <button
                type="button"
                onClick={onCycleTheme}
                className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-sm transition-colors hover:bg-[var(--hover-bg)]"
              >
                <div className="flex items-center gap-3">
                  {THEME_ICONS[themePreference]}
                  <span>Theme</span>
                </div>
                <span className="text-xs capitalize" style={{ color: "var(--text-muted)" }}>
                  {THEME_LABELS[themePreference]}
                </span>
              </button>

              {/* Tool lock */}
              <button
                type="button"
                onClick={onToggleToolLock}
                className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-sm transition-colors hover:bg-[var(--hover-bg)]"
              >
                <div className="flex items-center gap-3">
                  {toolLocked ? <FiLock size={16} /> : <FiUnlock size={16} />}
                  <span>Keep tool selected</span>
                </div>
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {toolLocked ? "On" : "Off"}
                </span>
              </button>

              {/* Collaborators */}
              {isCollaborative && users.length > 0 && (
                <div className="rounded-lg border p-3" style={{ borderColor: "var(--divider)", background: "var(--field-bg)" }}>
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold" style={{ color: "var(--text-muted)" }}>
                    <FiUsers size={14} />
                    <span>In this room ({users.length})</span>
                  </div>
                  <ul className="space-y-1">
                    {users.map((u) => (
                      <li key={u.id} className="flex items-center gap-2 text-xs">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--success)" }} />
                        <span>{u.tag}</span>
                        {u.id === currentUserId && (
                          <span style={{ color: "var(--text-faint)" }}>(you)</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Reset Canvas */}
              <button
                type="button"
                onClick={() => {
                  if (window.confirm("Are you sure you want to clear the canvas?")) {
                    onClear();
                    onToggleMenu();
                  }
                }}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-[var(--danger)] transition-colors hover:bg-[var(--danger-bg)]"
              >
                <FiTrash2 size={16} />
                <span>Reset Canvas</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default memo(MobileHeader);

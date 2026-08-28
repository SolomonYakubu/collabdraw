"use client";

import React, { memo } from "react";
import {
  FiCheck,
  FiCornerUpLeft,
  FiCornerUpRight,
  FiLink,
  FiMenu,
  FiX,
} from "react-icons/fi";
import { RiSparkling2Line } from "react-icons/ri";
import { MainMenuList, type MainMenuItem } from "./MainMenu";
import CollaboratorsButton from "./CollaboratorsButton";

export interface MobileHeaderProps {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onShare?: () => void;
  /** Overrides the share label — on the local canvas it starts a session. */
  shareLabel?: string;
  linkCopied?: boolean;
  isCollaborative?: boolean;
  isConnected?: boolean;
  users?: Array<{ id: string; tag: string }>;
  currentUserId?: string | null;
  onToggleAI?: () => void;
  isAIPanelOpen?: boolean;
  isAiGenerating?: boolean;
  aiConversationCount?: number;
  /** Same list the desktop hamburger renders. */
  menuItems: MainMenuItem[];
  isMenuOpen: boolean;
  onToggleMenu: () => void;
}

const MobileHeader: React.FC<MobileHeaderProps> = ({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onShare,
  shareLabel,
  linkCopied,
  isCollaborative = false,
  isConnected = false,
  users = [],
  currentUserId,
  onToggleAI,
  isAIPanelOpen = false,
  isAiGenerating = false,
  aiConversationCount = 0,
  menuItems,
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
            <>
              <div
                className="flex items-center gap-1.5 pl-1 pr-0.5 text-[11px] font-medium"
                style={{
                  color: isConnected ? "var(--success)" : "var(--text-faint)",
                }}
                aria-label={isConnected ? "Connected" : "Offline"}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{
                    background: isConnected
                      ? "var(--success)"
                      : "var(--text-faint)",
                  }}
                />
                {isConnected ? "Live" : "Off"}
              </div>
              <CollaboratorsButton
                users={users}
                currentUserId={currentUserId}
                align="left"
              />
            </>
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
              aria-label={
                linkCopied ? "Link copied" : (shareLabel ?? "Share link")
              }
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

            <div className="space-y-1">
              <MainMenuList items={menuItems} onAfterSelect={onToggleMenu} />
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default memo(MobileHeader);

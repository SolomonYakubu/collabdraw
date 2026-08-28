"use client";

/**
 * Tool island.
 *
 * Colours come from the design tokens rather than Tailwind's palette, so the
 * whole island themes without a single conditional in here.
 */
import { memo } from "react";
import {
  FiCircle,
  FiCornerUpLeft,
  FiCornerUpRight,
  FiDownload,
  FiEdit3,
  FiLink,
  FiLock,
  FiMinus,
  FiMonitor,
  FiMoon,
  FiMousePointer,
  FiSquare,
  FiSun,
  FiTrash2,
  FiType,
  FiUnlock,
} from "react-icons/fi";
import { FaEraser } from "react-icons/fa";
import { LuDiamond, LuTriangle } from "react-icons/lu";
import { PiHandGrabbing } from "react-icons/pi";
import { TbArrowNarrowRight } from "react-icons/tb";
import { RiSparkling2Line } from "react-icons/ri";

import type { ToolType } from "../../../types/shapes";
import { TOOL_SHORTCUTS } from "../../../hooks/canvas/useKeyboardShortcuts";
import type { ThemePreference } from "../../../hooks/useTheme";
import CollaboratorsButton from "./CollaboratorsButton";

export interface ToolbarProps {
  tool: ToolType;
  onToolChange: (tool: ToolType) => void;
  toolLocked: boolean;
  onToggleToolLock: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /**
   * Document-level actions are optional: on the canvas they live in the
   * top-left `MainMenu` (Excalidraw's split), and the tool island keeps to
   * drawing, undo/redo and collaboration. Passing them still renders them,
   * which is what the tests and any embedded use rely on.
   */
  onClear?: () => void;
  onExport?: () => void;
  onShare?: () => void;
  /** Overrides the share tooltip — on the local canvas it starts a session. */
  shareLabel?: string;
  linkCopied?: boolean;
  /**
   * Present only in a room. The list itself hangs off the people button — the
   * canvas carries no standing "who is here" panel.
   */
  users?: Array<{ id: string; tag: string }>;
  currentUserId?: string | null;
  onToggleAI?: () => void;
  isAIPanelOpen?: boolean;
  isAiGenerating?: boolean;
  aiConversationCount?: number;
  themePreference?: ThemePreference;
  onCycleTheme?: () => void;
}

const TOOL_ICONS: Record<string, React.ReactNode> = {
  Select: <FiMousePointer size={16} />,
  Pan: <PiHandGrabbing size={17} />,
  Square: <FiSquare size={16} />,
  Diamond: <LuDiamond size={17} />,
  Triangle: <LuTriangle size={16} />,
  Circle: <FiCircle size={16} />,
  Arrow: <TbArrowNarrowRight size={19} />,
  Line: <FiMinus size={17} />,
  Freehand: <FiEdit3 size={16} />,
  Text: <FiType size={16} />,
  Eraser: <FaEraser size={14} />,
};

const TOOL_LABELS: Record<string, string> = {
  Select: "Selection",
  Pan: "Hand (panning)",
  Square: "Rectangle",
  Diamond: "Diamond",
  Triangle: "Triangle",
  Circle: "Ellipse",
  Arrow: "Arrow",
  Line: "Line",
  Freehand: "Draw",
  Text: "Text",
  Eraser: "Eraser",
};

const THEME_ICONS: Record<ThemePreference, React.ReactNode> = {
  light: <FiSun size={14} />,
  dark: <FiMoon size={14} />,
  system: <FiMonitor size={14} />,
};

const THEME_LABELS: Record<ThemePreference, string> = {
  light: "Light theme — click for dark",
  dark: "Dark theme — click to follow your system",
  system: "Matching your system — click for light",
};

const IconButton: React.FC<{
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}> = ({ label, onClick, disabled, active, danger, children }) => (
  <button
    type="button"
    title={label}
    aria-label={label}
    onClick={onClick}
    disabled={disabled}
    data-active={active ? "true" : undefined}
    className={`island-button h-9 w-9 ${danger ? "island-button--danger" : ""}`}
  >
    {children}
  </button>
);

const Divider = () => (
  <span className="divider mx-1 h-6 w-px shrink-0" aria-hidden="true" />
);

const Toolbar: React.FC<ToolbarProps> = ({
  tool,
  onToolChange,
  toolLocked,
  onToggleToolLock,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClear,
  onExport,
  onShare,
  shareLabel,
  linkCopied,
  users,
  currentUserId,
  onToggleAI,
  isAIPanelOpen = false,
  isAiGenerating = false,
  aiConversationCount = 0,
  themePreference,
  onCycleTheme,
}) => (
  <div className="island pointer-events-auto no-scrollbar flex max-w-[calc(100vw-1.5rem)] items-center gap-0.5 overflow-x-auto p-1 md:p-1.5">
    <IconButton
      label={
        toolLocked
          ? "Tool stays active after drawing — Q to change"
          : "Back to selection after each shape — Q to change"
      }
      onClick={onToggleToolLock}
      active={toolLocked}
    >
      {toolLocked ? <FiLock size={14} /> : <FiUnlock size={14} />}
    </IconButton>

    <Divider />

    {TOOL_SHORTCUTS.map(({ tool: id, label }) => (
      <button
        key={id}
        type="button"
        title={`${TOOL_LABELS[id]} — ${label}`}
        aria-label={`${TOOL_LABELS[id]} — ${label}`}
        aria-pressed={tool === id}
        data-active={tool === id ? "true" : undefined}
        onClick={() => onToolChange(id)}
        className="island-button relative h-9 w-9 shrink-0"
      >
        {TOOL_ICONS[id]}
        <span
          className="pointer-events-none absolute bottom-0.5 right-1 hidden text-[9px] leading-none sm:inline"
          style={{ color: "var(--text-faint)" }}
        >
          {label}
        </span>
      </button>
    ))}

    <Divider />

    <IconButton label="Undo — Ctrl+Z" onClick={onUndo} disabled={!canUndo}>
      <FiCornerUpLeft size={15} />
    </IconButton>
    <IconButton
      label="Redo — Ctrl+Shift+Z"
      onClick={onRedo}
      disabled={!canRedo}
    >
      <FiCornerUpRight size={15} />
    </IconButton>

    <Divider />

    {onToggleAI && (
      <button
        type="button"
        title="Assistant"
        aria-label="Assistant"
        aria-pressed={isAIPanelOpen}
        data-active={isAIPanelOpen ? "true" : undefined}
        onClick={onToggleAI}
        className="island-button relative h-9 w-9 shrink-0"
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

    {onExport && (
      <IconButton label="Export as PNG" onClick={onExport}>
        <FiDownload size={15} />
      </IconButton>
    )}

    {onShare && (
      <IconButton
        label={
          linkCopied ? "Link copied" : (shareLabel ?? "Copy share link")
        }
        onClick={onShare}
        active={linkCopied}
      >
        <FiLink size={15} />
      </IconButton>
    )}

    {users && (
      <CollaboratorsButton users={users} currentUserId={currentUserId} />
    )}

    {(onCycleTheme || onClear) && <Divider />}

    {onCycleTheme && themePreference && (
      <IconButton label={THEME_LABELS[themePreference]} onClick={onCycleTheme}>
        {THEME_ICONS[themePreference]}
      </IconButton>
    )}

    {onClear && (
      <IconButton label="Reset the canvas" onClick={onClear} danger>
        <FiTrash2 size={15} />
      </IconButton>
    )}
  </div>
);

export default memo(Toolbar);

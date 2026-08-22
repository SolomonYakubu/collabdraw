"use client";

/** Zoom readout and controls. */
import { memo } from "react";
import { FiMaximize2, FiMinus, FiPlus } from "react-icons/fi";

interface ZoomControlsProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onZoomToFit: () => void;
}

const ZoomControls: React.FC<ZoomControlsProps> = ({
  zoom,
  onZoomIn,
  onZoomOut,
  onReset,
  onZoomToFit,
}) => (
  <div className="island pointer-events-auto flex items-center p-0.5">
    <button
      type="button"
      title="Zoom out — Ctrl+-"
      aria-label="Zoom out"
      onClick={onZoomOut}
      className="island-button h-8 w-8"
    >
      <FiMinus size={14} />
    </button>
    <button
      type="button"
      title="Reset zoom to 100% — Ctrl+0"
      aria-label="Reset zoom"
      onClick={onReset}
      className="island-button h-8 min-w-14 px-1 text-xs font-medium tabular-nums"
    >
      {Math.round(zoom * 100)}%
    </button>
    <button
      type="button"
      title="Zoom in — Ctrl++"
      aria-label="Zoom in"
      onClick={onZoomIn}
      className="island-button h-8 w-8"
    >
      <FiPlus size={14} />
    </button>
    <span className="divider mx-0.5 h-5 w-px" aria-hidden="true" />
    <button
      type="button"
      title="Zoom to fit — Shift+1"
      aria-label="Zoom to fit"
      onClick={onZoomToFit}
      className="island-button h-8 w-8"
    >
      <FiMaximize2 size={13} />
    </button>
  </div>
);

export default memo(ZoomControls);

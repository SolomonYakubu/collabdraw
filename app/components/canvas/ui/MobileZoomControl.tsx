"use client";

/**
 * Compact mobile zoom control.
 *
 * The desktop pill (− 100% + | fit) is wide; on a phone it ate a strip of the
 * canvas. Pinch is the primary way to zoom on touch anyway, so at rest this is
 * just a small percentage chip. Tapping it expands the full controls, and they
 * collapse again on the next tap outside.
 */
import { memo, useState } from "react";
import { FiMaximize2, FiMinus, FiPlus } from "react-icons/fi";

interface MobileZoomControlProps {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onZoomToFit: () => void;
}

const MobileZoomControl: React.FC<MobileZoomControlProps> = ({
  zoom,
  onZoomIn,
  onZoomOut,
  onReset,
  onZoomToFit,
}) => {
  const [expanded, setExpanded] = useState(false);
  const percent = Math.round(zoom * 100);

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-label="Zoom controls"
        aria-expanded={false}
        title="Zoom"
        className="island pointer-events-auto flex h-8 items-center justify-center rounded-lg px-2.5 text-xs font-medium tabular-nums shadow-lg transition-transform active:scale-95"
      >
        {percent}%
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        aria-label="Close zoom controls"
        className="pointer-events-auto fixed inset-0 z-[-1] cursor-default"
        onClick={() => setExpanded(false)}
      />
      <div className="island pointer-events-auto flex items-center p-0.5 shadow-lg">
        <button
          type="button"
          title="Zoom out"
          aria-label="Zoom out"
          onClick={onZoomOut}
          className="island-button h-8 w-8"
        >
          <FiMinus size={14} />
        </button>
        <button
          type="button"
          title="Reset zoom to 100%"
          aria-label="Reset zoom"
          onClick={onReset}
          className="island-button h-8 min-w-12 px-1 text-xs font-medium tabular-nums"
        >
          {percent}%
        </button>
        <button
          type="button"
          title="Zoom in"
          aria-label="Zoom in"
          onClick={onZoomIn}
          className="island-button h-8 w-8"
        >
          <FiPlus size={14} />
        </button>
        <span className="divider mx-0.5 h-5 w-px" aria-hidden="true" />
        <button
          type="button"
          title="Zoom to fit"
          aria-label="Zoom to fit"
          onClick={() => {
            onZoomToFit();
            setExpanded(false);
          }}
          className="island-button h-8 w-8"
        >
          <FiMaximize2 size={13} />
        </button>
      </div>
    </>
  );
};

export default memo(MobileZoomControl);

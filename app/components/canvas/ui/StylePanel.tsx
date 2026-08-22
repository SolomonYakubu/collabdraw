"use client";

/**
 * Element properties panel.
 *
 * Replaces the previous split between a toolbar colour popover and a separate
 * fill-colour modal, which each wrote a different set of rough.js options (one
 * of them with a random hachure angle per click, so the same colour produced a
 * different look every time).
 *
 * Editing a property applies it to the current selection and becomes the
 * default for new elements, which is how Excalidraw behaves.
 */
import { memo } from "react";
import {
  FiChevronsDown,
  FiChevronsUp,
  FiCopy,
  FiTrash2,
} from "react-icons/fi";
import {
  ROUGHNESS,
  type EdgeStyle,
  type ElementStyle,
  type FillStyle,
  type StrokeStyle,
} from "../../../types/shapes";

const STROKE_COLORS = ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00"];
const FILL_COLORS = ["transparent", "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99"];

const FILL_STYLES: Array<{ value: FillStyle; label: string }> = [
  { value: "hachure", label: "Hachure" },
  { value: "cross-hatch", label: "Cross-hatch" },
  { value: "solid", label: "Solid" },
  { value: "zigzag", label: "Zigzag" },
  { value: "dots", label: "Dots" },
];

const STROKE_STYLES: Array<{ value: StrokeStyle; label: string; dash: string }> = [
  { value: "solid", label: "Solid", dash: "" },
  { value: "dashed", label: "Dashed", dash: "6 4" },
  { value: "dotted", label: "Dotted", dash: "1 4" },
];

const STROKE_WIDTHS = [1, 2, 4];

const EDGE_STYLES: Array<{ value: EdgeStyle; label: string; path: string }> = [
  { value: "straight", label: "Straight", path: "M2 14 L18 4" },
  { value: "curved", label: "Curved", path: "M2 14 Q10 14 10 9 T18 4" },
  { value: "elbow", label: "Elbow", path: "M2 14 L10 14 Q12 14 12 12 L12 6 Q12 4 14 4 L18 4" },
];

const ROUGHNESS_LEVELS = [
  { value: ROUGHNESS.architect, label: "Architect" },
  { value: ROUGHNESS.artist, label: "Artist" },
  { value: ROUGHNESS.cartoonist, label: "Cartoonist" },
];

export interface StylePanelProps {
  style: ElementStyle;
  onStyleChange: (patch: Partial<ElementStyle>) => void;
  hasSelection: boolean;
  /** Fill and fill style only make sense for shapes that can hold a fill. */
  showFill: boolean;
  /** Arrow shape only applies to lines and arrows. */
  showEdgeStyle: boolean;
  onDelete: () => void;
  onDuplicate: () => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
}

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <div className="flex flex-col gap-1.5">
    <span
      className="text-[11px] font-medium"
      style={{ color: "var(--text-muted)" }}
    >
      {title}
    </span>
    {children}
  </div>
);

const Swatch: React.FC<{
  color: string;
  active: boolean;
  onSelect: () => void;
}> = ({ color, active, onSelect }) => {
  const isTransparent = color === "transparent";

  return (
    <button
      type="button"
      title={isTransparent ? "Transparent" : color}
      aria-label={isTransparent ? "Transparent" : color}
      aria-pressed={active}
      onClick={onSelect}
      className="relative h-6 w-6 overflow-hidden rounded border transition-transform hover:scale-105"
      style={{
        backgroundColor: isTransparent ? "var(--field-bg)" : color,
        borderColor: isTransparent ? "var(--field-border)" : "rgb(0 0 0 / 0.1)",
        boxShadow: active
          ? "0 0 0 2px var(--island-bg), 0 0 0 4px var(--accent)"
          : undefined,
      }}
    >
      {isTransparent && (
        <span className="absolute left-1/2 top-1/2 h-[1.5px] w-8 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-red-500" />
      )}
    </button>
  );
};

const Choice: React.FC<{
  active: boolean;
  label: string;
  onSelect: () => void;
  children: React.ReactNode;
}> = ({ active, label, onSelect, children }) => (
  <button
    type="button"
    title={label}
    aria-label={label}
    aria-pressed={active}
    onClick={onSelect}
    data-active={active ? "true" : undefined}
    className="island-button h-7 flex-1"
    style={active ? undefined : { background: "var(--hover-bg)" }}
  >
    {children}
  </button>
);

const StylePanel: React.FC<StylePanelProps> = ({
  style,
  onStyleChange,
  hasSelection,
  showFill,
  showEdgeStyle,
  onDelete,
  onDuplicate,
  onBringToFront,
  onSendToBack,
}) => (
  <div className="island pointer-events-auto flex w-52 flex-col gap-3 p-3">
    <Section title="Stroke">
      <div className="flex items-center gap-1.5">
        {STROKE_COLORS.map((color) => (
          <Swatch
            key={color}
            color={color}
            active={style.stroke === color}
            onSelect={() => onStyleChange({ stroke: color })}
          />
        ))}
        <input
          type="color"
          aria-label="Custom stroke colour"
          value={style.stroke}
          onChange={(event) => onStyleChange({ stroke: event.target.value })}
          className="field ml-auto h-6 w-6 cursor-pointer p-0"
        />
      </div>
    </Section>

    {showFill && (
      <>
        <Section title="Background">
          <div className="flex items-center gap-1.5">
            {FILL_COLORS.map((color) => (
              <Swatch
                key={color}
                color={color}
                active={style.fill === color}
                onSelect={() => onStyleChange({ fill: color })}
              />
            ))}
            <input
              type="color"
              aria-label="Custom background colour"
              value={style.fill === "transparent" ? "#ffffff" : style.fill}
              onChange={(event) => onStyleChange({ fill: event.target.value })}
              className="field ml-auto h-6 w-6 cursor-pointer p-0"
            />
          </div>
        </Section>

        {style.fill !== "transparent" && (
          <Section title="Fill">
            <div className="flex gap-1">
              {FILL_STYLES.map(({ value, label }) => (
                <Choice
                  key={value}
                  label={label}
                  active={style.fillStyle === value}
                  onSelect={() => onStyleChange({ fillStyle: value })}
                >
                  <span className="text-[10px]">{label.slice(0, 2)}</span>
                </Choice>
              ))}
            </div>
          </Section>
        )}
      </>
    )}

    {showEdgeStyle && (
      <Section title="Arrow shape">
        <div className="flex gap-1">
          {EDGE_STYLES.map(({ value, label, path }) => (
            <Choice
              key={value}
              label={label}
              active={style.edgeStyle === value}
              onSelect={() => onStyleChange({ edgeStyle: value })}
            >
              <svg width="20" height="18" aria-hidden="true">
                <path
                  d={path}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                />
              </svg>
            </Choice>
          ))}
        </div>
      </Section>
    )}

    <Section title="Stroke width">
      <div className="flex gap-1">
        {STROKE_WIDTHS.map((width) => (
          <Choice
            key={width}
            label={`${width}px`}
            active={style.strokeWidth === width}
            onSelect={() => onStyleChange({ strokeWidth: width })}
          >
            <svg width="20" height="10" aria-hidden="true">
              <line
                x1="2"
                y1="5"
                x2="18"
                y2="5"
                stroke="currentColor"
                strokeWidth={width}
                strokeLinecap="round"
              />
            </svg>
          </Choice>
        ))}
      </div>
    </Section>

    <Section title="Stroke style">
      <div className="flex gap-1">
        {STROKE_STYLES.map(({ value, label, dash }) => (
          <Choice
            key={value}
            label={label}
            active={style.strokeStyle === value}
            onSelect={() => onStyleChange({ strokeStyle: value })}
          >
            <svg width="20" height="10" aria-hidden="true">
              <line
                x1="2"
                y1="5"
                x2="18"
                y2="5"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray={dash || undefined}
                strokeLinecap="round"
              />
            </svg>
          </Choice>
        ))}
      </div>
    </Section>

    <Section title="Sloppiness">
      <div className="flex gap-1">
        {ROUGHNESS_LEVELS.map(({ value, label }) => (
          <Choice
            key={label}
            label={label}
            active={style.roughness === value}
            onSelect={() => onStyleChange({ roughness: value })}
          >
            <span className="text-[10px]">{label.slice(0, 3)}</span>
          </Choice>
        ))}
      </div>
    </Section>

    <Section title={`Opacity — ${style.opacity}%`}>
      <input
        type="range"
        min={10}
        max={100}
        step={10}
        value={style.opacity}
        aria-label="Opacity"
        onChange={(event) =>
          onStyleChange({ opacity: Number(event.target.value) })
        }
        className="h-1.5 w-full cursor-pointer"
        style={{ accentColor: "var(--accent)" }}
      />
    </Section>

    {hasSelection && (
      <Section title="Actions">
        <div className="flex gap-1">
          <Choice label="Send to back — Ctrl+Shift+[" active={false} onSelect={onSendToBack}>
            <FiChevronsDown size={14} />
          </Choice>
          <Choice label="Bring to front — Ctrl+Shift+]" active={false} onSelect={onBringToFront}>
            <FiChevronsUp size={14} />
          </Choice>
          <Choice label="Duplicate — Ctrl+D" active={false} onSelect={onDuplicate}>
            <FiCopy size={14} />
          </Choice>
          <button
            type="button"
            title="Delete — Del"
            aria-label="Delete"
            onClick={onDelete}
            className="island-button island-button--danger h-7 flex-1"
            style={{ background: "var(--hover-bg)" }}
          >
            <FiTrash2 size={14} />
          </button>
        </div>
      </Section>
    )}
  </div>
);

export default memo(StylePanel);

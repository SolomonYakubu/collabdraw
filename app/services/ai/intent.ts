/**
 * What the model was asked to make.
 *
 * The first version of this pipeline only understood node-and-edge diagrams, so
 * every request became a block diagram — asking for a tic-tac-toe board got you
 * boxes labelled "Player X" pointing at boxes labelled "Board". The fix is not
 * to go back to asking for raw pixel coordinates; it is to recognise that most
 * drawings have *some* structure, and to give each kind its own contract:
 *
 *  - `diagram` — nodes and the connections between them. Layered layout.
 *  - `grid`    — rows and columns: boards, tables, calendars, matrices.
 *  - `scene`   — free placement on a 0-100 canvas, for everything else.
 *
 * `scene` still avoids absolute pixels: a normalised space is something models
 * are far better at, and it can be validated and scaled deterministically.
 */
import { parseDiagramGraph, type DiagramGraph, type NodeAccent } from "./graph";
import { parseGridSpec, type GridSpec } from "./grid";
import { parseSceneSpec, type SceneSpec } from "./scene";
import { parseSequenceSpec, type SequenceSpec } from "./sequence";
import { parseSystemSpec, type SystemSpec } from "./system";

export type IntentKind = "diagram" | "grid" | "sequence" | "system" | "scene";

export const INTENT_KINDS: IntentKind[] = [
  "diagram",
  "grid",
  "sequence",
  "system",
  "scene",
];

/**
 * Where the reply's content belongs relative to what is already drawn.
 *
 * This used to be guessed from the prompt with a keyword regex, and the guess was
 * wrong in the case that matters: "I need something beyond a flowchart" contains
 * none of `clear|reset|start over`, so a reply that said in its own summary that
 * it had *replaced* the flowchart was forced to be additive — and then drawn on
 * top of it. The model knows its own intent; it only needed somewhere to say so.
 */
export type Placement = "replace" | "add" | "beside";

export const PLACEMENTS: Placement[] = ["replace", "add", "beside"];

/**
 * Whether the reply wants the canvas touched at all.
 *
 * Automatic turns (the assistant noticing the user paused) used to command a
 * response, so the model drew something every time — even when the user was
 * merely rearranging their own work. Giving the model an explicit "wait" lets
 * it decline; absent or unknown values mean "draw", which keeps older replies
 * and tests working unchanged.
 */
export type IntentAction = "draw" | "wait";

export const INTENT_ACTIONS: IntentAction[] = ["draw", "wait"];

export interface IntentEnvelope {
  title: string;
  summary: string;
  placement: Placement;
  action: IntentAction;
}

export type DrawingIntent = IntentEnvelope &
  (
    | { kind: "diagram"; diagram: DiagramGraph }
    | { kind: "grid"; grid: GridSpec }
    | { kind: "sequence"; sequence: SequenceSpec }
    | { kind: "system"; system: SystemSpec }
    | { kind: "scene"; scene: SceneSpec }
  );

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const asBoolean = (value: unknown, fallback = false): boolean =>
  typeof value === "boolean" ? value : fallback;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/**
 * Parse a reply into an intent.
 *
 * `kind` is treated as a hint rather than gospel: models sometimes name one kind
 * and fill in another, so whichever payload actually has content wins. That is
 * cheaper and more robust than rejecting the reply and asking again.
 */
export const parseDrawingIntent = (
  input: unknown,
  knownNodeIds: ReadonlySet<string> = new Set(),
): DrawingIntent | null => {
  const raw = asRecord(input);

  const placement = PLACEMENTS.includes(raw.placement as Placement)
    ? (raw.placement as Placement)
    // An older reply, or one that omitted it: `replaceCanvas` was the previous
    // spelling, and adding is the safe default.
    : asBoolean(raw.replaceCanvas)
      ? "replace"
      : "add";

  const action: IntentAction = INTENT_ACTIONS.includes(raw.action as IntentAction)
    ? (raw.action as IntentAction)
    : "draw";

  const envelope: IntentEnvelope = {
    title: asString(raw.title).trim().slice(0, 80),
    summary: asString(raw.summary).trim().slice(0, 400),
    placement,
    action,
  };

  const declared = INTENT_KINDS.includes(raw.kind as IntentKind)
    ? (raw.kind as IntentKind)
    : null;

  // Parse every payload that is present, then pick.
  const diagram = parseDiagramGraph(
    {
      ...raw,
      ...asRecord(raw.diagram),
      replaceCanvas: placement === "replace",
    },
    knownNodeIds,
  );
  const grid = parseGridSpec(raw.grid ?? raw);
  const sequence = parseSequenceSpec(raw.sequence ?? raw);
  const system = parseSystemSpec(raw.system ?? raw);
  const scene = parseSceneSpec(raw.scene ?? raw);

  const candidates: DrawingIntent[] = [];

  const push = (kind: IntentKind) => {
    if (kind === "diagram" && diagram) {
      candidates.push({ ...envelope, kind, diagram });
    } else if (kind === "grid" && grid) {
      candidates.push({ ...envelope, kind, grid });
    } else if (kind === "sequence" && sequence) {
      candidates.push({ ...envelope, kind, sequence });
    } else if (kind === "system" && system) {
      candidates.push({ ...envelope, kind, system });
    } else if (kind === "scene" && scene) {
      candidates.push({ ...envelope, kind, scene });
    }
  };

  // The declared kind gets first refusal, then the others in preference order.
  if (declared) {
    push(declared);
  }
  for (const kind of INTENT_KINDS) {
    if (kind !== declared) {
      push(kind);
    }
  }

  return candidates[0] ?? null;
};

export type {
  DiagramGraph,
  GridSpec,
  NodeAccent,
  SceneSpec,
  SequenceSpec,
  SystemSpec,
};

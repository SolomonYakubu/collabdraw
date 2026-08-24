import { NextResponse, type NextRequest } from "next/server";

import {
  CONFIG_ERROR_MESSAGE,
  completeDrawing,
  resolveProvider,
  streamDrawing,
  type HistoryTurn as ModelHistoryTurn,
  type ModelCall,
} from "../../services/ai/llm";

import {
  MAX_EDGES,
  MAX_LABEL_LENGTH,
  MAX_NODES,
  NODE_ACCENTS,
  NODE_SHAPES,
} from "../../services/ai/graph";
import {
  INTENT_KINDS,
  parseDrawingIntent,
  PLACEMENTS,
} from "../../services/ai/intent";
import { MAX_GRID_SIDE } from "../../services/ai/grid";
import { MAX_SCENE_ITEMS, SCENE_SHAPES } from "../../services/ai/scene";
import {
  MAX_MESSAGES,
  MAX_PARTICIPANTS,
  MESSAGE_KINDS,
} from "../../services/ai/sequence";
import {
  EMPTY_SCENE,
  formatSceneForPrompt,
  type SceneSummary,
} from "../../services/ai/describeScene";

/**
 * Drawing generation.
 *
 * The model returns a *structured description* under an enforced JSON schema,
 * and the client turns that into elements. Three kinds are understood:
 *
 *  - `diagram` — nodes and edges, laid out in layers.
 *  - `grid`    — rows and columns: boards, tables, calendars, matrices.
 *  - `scene`   — free placement on a normalised 0-100 canvas.
 *
 * The model itself is whatever the environment points at — Gemini, OpenAI,
 * OpenRouter or any OpenAI-compatible host. The route only states the prompt
 * and the reply shape; `services/ai/llm.ts` owns how a completion is actually
 * sent and received.
 */

/** Enforced reply shape: an envelope plus one payload per kind of drawing.
 *
 * Written in plain JSON Schema and converted per transport, so adding a
 * provider never means restating it.
 */
const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: INTENT_KINDS,
      description:
        "Which payload you filled in. 'sequence' for an ordered exchange between participants over time — most \"how does X work\" questions; 'scene' for a picture of something or a spatial layout; 'grid' for rows and columns (boards, tables, calendars, matrices); 'diagram' for abstract things joined by arrows, with no time axis and no picture.",
    },
    title: {
      type: "string",
      description: "A short name for the drawing.",
    },
    summary: {
      type: "string",
      description:
        "One or two sentences for the user describing what you produced or changed.",
    },
    placement: {
      type: "string",
      enum: PLACEMENTS,
      description:
        "Where your output goes. 'add' extends what is on the canvas — the usual case when you are adding to or continuing an existing drawing. 'replace' clears the canvas first; use it when the user asks to start over, or when you are producing a different rendering of the same thing so the old one should not remain. 'beside' keeps the canvas and puts your output in clear space next to it, for a separate drawing that should stand alongside.",
    },
    action: {
      type: "string",
      enum: ["draw", "wait"],
      description:
        "Whether to touch the canvas at all. 'wait' when nothing you could draw would help right now — the user is still arranging their own work, asked a question about what is there, or any drawing would interrupt them. With 'wait' your summary is still shown, but nothing is drawn. Default 'draw'.",
    },

    diagram: {
      type: "object",
      description:
        "Fill this only when kind is 'diagram': things connected to other things.",
      properties: {
        direction: {
          type: "string",
          enum: ["down", "right"],
          description:
            "'down' for processes and hierarchies, 'right' for pipelines and request flows.",
        },
        nodes: {
          type: "array",
          description: `The boxes. At most ${MAX_NODES}.`,
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description:
                  "Short identifier referenced by edges. Reuse an existing node's exact label to attach to it.",
              },
              label: {
                type: "string",
                description: `Text in the box, under ${MAX_LABEL_LENGTH} characters.`,
              },
              shape: {
                type: "string",
                enum: NODE_SHAPES,
                description:
                  "'rectangle' for a step or component, 'diamond' for a decision, 'ellipse' for a start or end point.",
              },
              accent: {
                type: "string",
                enum: NODE_ACCENTS,
                description:
                  "Background colour; 'none' leaves the box unfilled.",
              },
            },
            required: ["id", "label", "shape", "accent"],
          },
        },
        edges: {
          type: "array",
          description: `Connections between nodes. At most ${MAX_EDGES}.`,
          items: {
            type: "object",
            properties: {
              from: { type: "string", description: "Source node id." },
              to: { type: "string", description: "Target node id." },
              label: {
                type: "string",
                description: "Short text such as 'yes' or 'no'; empty if none.",
              },
              dashed: {
                type: "boolean",
                description: "True for optional or asynchronous relationships.",
              },
            },
            required: ["from", "to", "label", "dashed"],
          },
        },
        removedEdges: {
          type: "array",
          description:
            "Existing connections to delete. Needed when inserting a node between two already-connected ones. Empty array otherwise.",
          items: {
            type: "object",
            properties: {
              from: { type: "string" },
              to: { type: "string" },
            },
            required: ["from", "to"],
          },
        },
      },
      required: ["direction", "nodes", "edges", "removedEdges"],
    },

    grid: {
      type: "object",
      description:
        "Fill this only when kind is 'grid': anything arranged in rows and columns. The application draws perfectly even cells, so give only counts and contents.",
      properties: {
        rows: {
          type: "integer",
          description: `Number of rows, 1 to ${MAX_GRID_SIDE}.`,
        },
        columns: {
          type: "integer",
          description: `Number of columns, 1 to ${MAX_GRID_SIDE}.`,
        },
        style: {
          type: "string",
          enum: ["board", "table"],
          description:
            "'board' draws only the lines between cells, which is what a tic-tac-toe or noughts-and-crosses grid looks like. 'table' outlines every cell.",
        },
        headerRow: {
          type: "boolean",
          description: "Shade the first row, for a table with column headings.",
        },
        cells: {
          type: "array",
          description:
            "Only the cells that have content. Leave the array empty for a blank grid.",
          items: {
            type: "object",
            properties: {
              row: {
                type: "integer",
                description: "0-based row index.",
              },
              column: {
                type: "integer",
                description: "0-based column index.",
              },
              text: {
                type: "string",
                description: "Cell contents, e.g. 'X', 'O', or a short label.",
              },
              accent: {
                type: "string",
                enum: NODE_ACCENTS,
                description: "Cell colour; 'none' for plain.",
              },
            },
            required: ["row", "column", "text", "accent"],
          },
        },
      },
      required: ["rows", "columns", "style", "headerRow", "cells"],
    },

    sequence: {
      type: "object",
      description:
        "Fill this only when kind is 'sequence': who does what, in order, over time. Lifelines, spacing and label placement are computed for you — give only the participants and the ordered messages.",
      properties: {
        participants: {
          type: "array",
          description: `The actors, left to right in the order they first take part. Two to ${MAX_PARTICIPANTS}.`,
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "Short identifier referenced by messages.",
              },
              label: {
                type: "string",
                description:
                  "Name shown at the top, e.g. 'Client', 'API', 'Database'. Keep it short.",
              },
              accent: {
                type: "string",
                enum: NODE_ACCENTS,
                description: "Header colour; 'none' for plain.",
              },
            },
            required: ["id", "label", "accent"],
          },
        },
        messages: {
          type: "array",
          description: `The exchanges, in the order they happen. At most ${MAX_MESSAGES}.`,
          items: {
            type: "object",
            properties: {
              from: { type: "string", description: "Sender's id." },
              to: {
                type: "string",
                description:
                  "Recipient's id. The same as 'from' for a self-call.",
              },
              label: {
                type: "string",
                description:
                  "What is sent, e.g. 'POST /pay (key: 123)' or '200 OK'. Short.",
              },
              kind: {
                type: "string",
                enum: MESSAGE_KINDS,
                description:
                  "'call' for a request (solid), 'return' for what comes back (dashed), 'self' for work a participant does on its own.",
              },
              section: {
                type: "string",
                description:
                  "Starts a labelled phase at this message, e.g. 'First attempt' or 'Duplicate retry'. Empty string for most messages.",
              },
            },
            required: ["from", "to", "label", "kind", "section"],
          },
        },
      },
      required: ["participants", "messages"],
    },

    scene: {
      type: "object",
      description:
        "Fill this only when kind is 'scene': any other picture or layout. Positions are on a 0-100 square canvas, NOT pixels. 0,0 is top-left; 100,100 is bottom-right.",
      properties: {
        items: {
          type: "array",
          description: `The shapes making up the picture. At most ${MAX_SCENE_ITEMS}. Order matters: later items draw on top.`,
          items: {
            type: "object",
            properties: {
              shape: {
                type: "string",
                enum: SCENE_SHAPES,
                description: "Which primitive to draw.",
              },
              x: {
                type: "number",
                description:
                  "Left edge, 0-100. For a line or arrow, the start point's x.",
              },
              y: {
                type: "number",
                description:
                  "Top edge, 0-100. For a line or arrow, the start point's y.",
              },
              width: {
                type: "number",
                description:
                  "Width, 0-100. For text, ignored. For a line or arrow, ignored.",
              },
              height: {
                type: "number",
                description:
                  "Height, 0-100. For text this sets the font size, so use about 4 for body text and 8 or more for a heading.",
              },
              x2: {
                type: "number",
                description: "End point x for a line or arrow, 0-100. Else 0.",
              },
              y2: {
                type: "number",
                description: "End point y for a line or arrow, 0-100. Else 0.",
              },
              text: {
                type: "string",
                description:
                  "For 'text', the words to draw. For a shape, an optional centred label. Empty otherwise.",
              },
              accent: {
                type: "string",
                enum: NODE_ACCENTS,
                description: "Colour; 'none' draws in the default ink.",
              },
              filled: {
                type: "boolean",
                description:
                  "True to fill the shape with its accent colour rather than leaving it as an outline.",
              },
              rotation: {
                type: "number",
                description:
                  "Clockwise rotation in degrees about the shape's own centre, 0-359. Use 0 unless the thing really is tilted — a roof strut, a leaning ladder, a rotated label, a clock hand. Lines and arrows do not need it; give them the ends you want instead.",
              },
            },
            required: [
              "shape",
              "x",
              "y",
              "width",
              "height",
              "x2",
              "y2",
              "text",
              "accent",
              "filled",
              "rotation",
            ],
          },
        },
      },
      required: ["items"],
    },
  },
  required: ["kind", "title", "summary", "placement", "action"],
};

const SYSTEM_INSTRUCTION = `You draw on a whiteboard by describing what to draw.

You never give pixel coordinates. Each kind of drawing has its own structure, and
the application does the layout, sizing and spacing.

CHOOSING A KIND
Read the request and ask what the answer actually looks like. Do not default to a
flowchart — most questions are not flowcharts.

- Is it a thing with PARTS or a PICTURE of something?           -> "scene"
- Is it arranged in ROWS AND COLUMNS?                           -> "grid"
- Is it a SEQUENCE of exchanges between participants over time?  -> "sequence"
- Is it ABSTRACT THINGS CONNECTED to each other?                -> "diagram"

Worked examples, because this is where it usually goes wrong:
- "how does idempotency work"        -> sequence (client, API, cache; the retry)
- "how does OAuth work"              -> sequence
- "how does a TCP handshake work"    -> sequence
- "what happens when I type a URL"   -> sequence
- "explain a pendulum's physics"     -> scene (drawn pendulum, labelled forces)
- "draw a house" / "a cat" / "a rocket" -> scene
- "a UI mock-up" / "a floor plan"    -> scene
- "tic-tac-toe" / "a calendar" / "compare REST and GraphQL" -> grid
- "our microservice architecture"    -> diagram
- "the steps to onboard a customer"  -> diagram
- "an org chart"                     -> diagram

"how does X work" is a sequence far more often than a flowchart. Reach for
"diagram" only when the answer really is boxes joined by arrows with no time
axis and no picture.

"sequence" — participants and ordered messages. Lifelines, spacing and labels are
computed for you.
- Participants left to right in the order they first appear.
- One message per exchange, in order. 'call' for a request, 'return' for the
  reply (drawn dashed), 'self' for work a participant does alone.
- Use "section" to name a phase — "First attempt", "Duplicate retry" — on the
  first message of that phase. This is how you show two runs of the same flow.
- Put the concrete detail in the labels: "POST /pay (key: 123)", "200 OK (cached)".

"grid" — anything on rows and columns: a tic-tac-toe or noughts-and-crosses
board, chess or draughts board, a table, a calendar, a matrix, a seating plan.
- Give rows, columns, and only the cells that have content.
- style 'board' for game boards; 'table' when the cells hold data.
- Tic-tac-toe is rows 3, columns 3, style 'board'.

"scene" — a picture of something, or a layout in space. Whenever the request is
about how something LOOKS or is physically arranged.
- Big shapes first, then details on top, then labels. Later items draw over
  earlier ones.
- Be generous with detail. A drawing worth looking at is usually 10-25 items.
- Keep it roughly centred and fill most of the canvas. Check the arithmetic:
  x + width and y + height must stay under 100.
- Nothing should sit on top of something it would obscure. Give arrows and their
  labels their own space.
- Label with the shape's or arrow's own "text" field; it is positioned for you.
  Use a separate "text" item only for titles and free annotations.
- "rotation" tilts a shape about its own centre, in degrees. Use it when
  something genuinely sits at an angle — a roof strut, a leaning ladder — and
  leave it at 0 otherwise.
- For a forces figure: draw the object away from its rest position so the forces
  are distinguishable, one arrow per force labelled with its symbol, a dashed
  line for the rest position, and a marker at the pivot.

"diagram" — abstract things connected to abstract things: architectures, org
charts, state machines, mind maps, decision trees, process steps.
- Labels: one to four words, under 24 characters. The label decides how big its
  box is drawn.
- Edge direction matters: cause to effect, caller to callee, step to next step.
- 'diamond' for a decision, with its conditions as the outgoing edge labels.
- Loops are fine — send "not resolved" back to the step it repeats.
- Aim for 4-10 nodes, all connected.
- To insert B between A and C: add B, add A->B and B->C, and put
  {"from":"A","to":"C"} in removedEdges.

PLACEMENT — where your output goes
You are told what is already on the canvas, and where. Choose deliberately:
- "add" when you are extending, finishing or continuing what is there. A grid is
  written into the existing board; a scene lands on the existing drawing.
- "replace" when your output supersedes what is there — the user asked to start
  over, or asked for the same thing drawn a different way, so leaving the old
  version would just be two drawings on top of each other.
- "beside" for a separate drawing that should stand next to the existing one.

If the user says a previous answer was wrong, or asks for a different rendering of
the same subject, that is "replace" — not "add".

General:
- Do exactly what was asked. Do not turn a picture into a diagram about the
  picture, and do not add commentary boxes.
- Keep text short everywhere. Long strings make big shapes and crowded drawings.

WHEN NOT TO DRAW (action "wait")
Some requests arrive while the user is mid-thought, or are not drawing requests
at all. Before answering, ask: would what I am about to draw be an improvement
to THIS canvas, or just activity? Choose "wait" when:
- The user is clearly still working — the request is vague ("hmm", "ok", "wait"),
  or describes something half-finished they are likely still arranging.
- They asked a QUESTION about the canvas rather than for a change: "what have I
  drawn?", "is this right?", "what is missing?" Answer in your summary; draw
  nothing.
- Anything you could add would sit on top of work they have not finished.
- You would only be repeating, re-labelling or slightly moving what is already
  there without being asked.
When you wait, say briefly and usefully why in "summary" — that is still shown.
Choose "draw" whenever the user asked for something concrete, even if it is
small; hesitation must never turn a real request into silence.

CONTINUING WHAT IS ALREADY THERE
Before each request you are given the canvas twice: as a picture, and as a
structured description. Look at the picture to understand what has been drawn —
especially freehand strokes, which no description can convey — and use the
description for the exact coordinates and names to build on.
- If a grid is described and you are adding to it, reply with "grid", the SAME
  rows and columns, and the FULL list of cells you want to end up with. It is
  updated in place. To take a turn in a game, repeat the existing marks and add
  yours.
- If canvas items are listed in 0-100 coordinates and you are adding to that
  drawing, reply with "scene" in those same coordinates and list only what is NEW.
- If diagram nodes are listed, reply with "diagram", list only new nodes, and
  refer to existing ones in edges by their exact existing label.`;

interface RequestBody {
  prompt?: unknown;
  scene?: unknown;
  /** A data URL snapshot of the canvas. */
  image?: unknown;
  history?: unknown;
  /**
   * When true the reply streams back as raw JSON text as the model writes it,
   * so the client can draw a scene shape by shape. Validation then happens on
   * the client. When absent the reply comes back parsed as `{ intent }`.
   */
  stream?: unknown;
}

/**
 * Largest snapshot accepted, as base64 characters. Roughly 3 MB of image, which
 * a 896px-wide PNG stays comfortably under.
 */
const MAX_IMAGE_BASE64 = 4_000_000;

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

/**
 * Pull an inline image part out of a data URL.
 *
 * A description cannot convey a freehand sketch, so the canvas is also sent as a
 * picture; anything malformed or oversized is simply dropped rather than failing
 * the request, since the structured description alone still works.
 */
const parseInlineImage = (
  input: unknown,
): { mimeType: string; data: string } | null => {
  if (typeof input !== "string" || !input.startsWith("data:")) {
    return null;
  }

  const separator = input.indexOf(",");
  if (separator === -1) {
    return null;
  }

  const header = input.slice(5, separator);
  const data = input.slice(separator + 1);

  if (!header.endsWith(";base64") || data.length > MAX_IMAGE_BASE64) {
    return null;
  }

  const mimeType = header.slice(0, -";base64".length);

  return SUPPORTED_IMAGE_TYPES.has(mimeType) ? { mimeType, data } : null;
};

interface HistoryTurn {
  role: "user" | "model";
  parts: Array<{ text: string }>;
}

/** Keep the transcript short; the canvas graph already carries the state. */
const MAX_HISTORY_TURNS = 8;

const parseHistory = (input: unknown): ModelHistoryTurn[] => {
  if (!Array.isArray(input)) {
    return [];
  }

  const turns: ModelHistoryTurn[] = [];

  for (const candidate of input) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const turn = candidate as { role?: unknown; parts?: unknown };
    const role: ModelHistoryTurn["role"] =
      turn.role === "model" ? "model" : "user";
    const parts = Array.isArray(turn.parts) ? turn.parts : [];
    const text = parts
      .map((part) =>
        part &&
        typeof part === "object" &&
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n");

    if (text) {
      turns.push({ role, text: text.slice(0, 2000) });
    }
  }

  // Gemini requires the transcript to begin with a user turn; harmless for the
  // OpenAI-compatible path, so one rule serves both.
  const trimmed = turns.slice(-MAX_HISTORY_TURNS);
  while (trimmed.length > 0 && trimmed[0].role !== "user") {
    trimmed.shift();
  }

  return trimmed;
};

/**
 * The scene description is produced by the client, so it only needs sanity
 * limits here rather than full validation.
 */
const parseScene = (input: unknown): SceneSummary => {
  if (!input || typeof input !== "object") {
    return EMPTY_SCENE;
  }

  const scene = input as Partial<SceneSummary>;

  return {
    nodes: Array.isArray(scene.nodes) ? scene.nodes.slice(0, MAX_NODES) : [],
    edges: Array.isArray(scene.edges) ? scene.edges.slice(0, MAX_EDGES) : [],
    items: Array.isArray(scene.items) ? scene.items.slice(0, 80) : [],
    grid: scene.grid ?? null,
    bounds: scene.bounds ?? null,
    otherCount:
      typeof scene.otherCount === "number" && scene.otherCount > 0
        ? Math.floor(scene.otherCount)
        : 0,
  };
};

export async function POST(request: NextRequest) {
  const provider = resolveProvider();

  if (!provider) {
    return NextResponse.json(
      { error: CONFIG_ERROR_MESSAGE },
      { status: 503 },
    );
  }

  let body: RequestBody;

  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return NextResponse.json(
      { error: "Malformed request body." },
      { status: 400 },
    );
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

  if (!prompt) {
    return NextResponse.json(
      { error: "A prompt is required." },
      { status: 400 },
    );
  }

  const scene = parseScene(body.scene);
  const history = parseHistory(body.history);
  const image = parseInlineImage(body.image);
  const wantsStream = body.stream === true;

  try {
    const call: ModelCall = {
      system: SYSTEM_INSTRUCTION,
      history,
      userText: [
        image
          ? "The attached image shows the canvas as it looks right now."
          : null,
        `Current canvas:\n${formatSceneForPrompt(scene)}`,
        `Request: ${prompt}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      image,
    };

    /*
     * Streaming path: hand the model's JSON back verbatim as it is written, so
     * the client can render a scene item by item. It is a single JSON document,
     * not SSE — the client accumulates and parses it. Parsing and validation
     * move to the client, which already owns the builders.
     */
    if (wantsStream) {
      const stream = await streamDrawing(provider, call, {
        schema: RESPONSE_SCHEMA,
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          // Ask intermediaries not to buffer, so deltas arrive as they are sent.
          "X-Accel-Buffering": "no",
        },
      });
    }

    const reply = await completeDrawing(provider, call, {
      schema: RESPONSE_SCHEMA,
    });

    let parsed: unknown;

    try {
      parsed = JSON.parse(reply);
    } catch {
      // With a response schema this should not happen; a blocked or truncated
      // reply is the realistic cause.
      return NextResponse.json(
        {
          error:
            "The assistant returned an unreadable reply. Please try again.",
        },
        { status: 502 },
      );
    }

    // Existing node ids are addressable in a diagram's edges, so the validator
    // has to know about them or every new connection would look like a dangling
    // edge and be discarded.
    const knownIds = new Set(scene.nodes.map((node) => node.id));
    const intent = parseDrawingIntent(parsed, knownIds);

    if (!intent) {
      return NextResponse.json(
        {
          error:
            "The assistant did not describe anything drawable. Try rephrasing the request.",
        },
        { status: 422 },
      );
    }

    return NextResponse.json({ intent }, { status: 200 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error from the model.";
    console.error("generate-drawing failed:", message);

    return NextResponse.json(
      { error: `The assistant could not be reached: ${message}` },
      { status: 502 },
    );
  }
}

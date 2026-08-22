import { NextResponse, type NextRequest } from "next/server";
import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
  SchemaType,
  type ResponseSchema,
} from "@google/generative-ai";

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
 * The first version only had `diagram`, which meant every request came back as a
 * block diagram: asking for a tic-tac-toe board produced boxes with arrows
 * between them. Adding kinds fixes that without giving up what made the diagram
 * path reliable — the model is still never asked for absolute pixel coordinates,
 * and `responseSchema` still guarantees the reply parses, so there is no JSON to
 * repair and no bad geometry to rescue afterwards.
 */

const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const API_KEY = process.env.GEMINI_API_KEY;

/** Enforced reply shape: an envelope plus one payload per kind of drawing. */
const RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    kind: {
      type: SchemaType.STRING,
      format: "enum",
      enum: INTENT_KINDS as unknown as string[],
      description:
        "Which payload you filled in. 'sequence' for an ordered exchange between participants over time — most \"how does X work\" questions; 'scene' for a picture of something or a spatial layout; 'grid' for rows and columns (boards, tables, calendars, matrices); 'diagram' for abstract things joined by arrows, with no time axis and no picture.",
    },
    title: {
      type: SchemaType.STRING,
      description: "A short name for the drawing.",
    },
    summary: {
      type: SchemaType.STRING,
      description:
        "One or two sentences for the user describing what you produced or changed.",
    },
    placement: {
      type: SchemaType.STRING,
      format: "enum",
      enum: PLACEMENTS as unknown as string[],
      description:
        "Where your output goes. 'add' extends what is on the canvas — the usual case when you are adding to or continuing an existing drawing. 'replace' clears the canvas first; use it when the user asks to start over, or when you are producing a different rendering of the same thing so the old one should not remain. 'beside' keeps the canvas and puts your output in clear space next to it, for a separate drawing that should stand alongside.",
    },

    diagram: {
      type: SchemaType.OBJECT,
      description:
        "Fill this only when kind is 'diagram': things connected to other things.",
      properties: {
        direction: {
          type: SchemaType.STRING,
          format: "enum",
          enum: ["down", "right"],
          description:
            "'down' for processes and hierarchies, 'right' for pipelines and request flows.",
        },
        nodes: {
          type: SchemaType.ARRAY,
          description: `The boxes. At most ${MAX_NODES}.`,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              id: {
                type: SchemaType.STRING,
                description:
                  "Short identifier referenced by edges. Reuse an existing node's exact label to attach to it.",
              },
              label: {
                type: SchemaType.STRING,
                description: `Text in the box, under ${MAX_LABEL_LENGTH} characters.`,
              },
              shape: {
                type: SchemaType.STRING,
                format: "enum",
                enum: NODE_SHAPES as unknown as string[],
                description:
                  "'rectangle' for a step or component, 'diamond' for a decision, 'ellipse' for a start or end point.",
              },
              accent: {
                type: SchemaType.STRING,
                format: "enum",
                enum: NODE_ACCENTS as unknown as string[],
                description:
                  "Background colour; 'none' leaves the box unfilled.",
              },
            },
            required: ["id", "label", "shape", "accent"],
          },
        },
        edges: {
          type: SchemaType.ARRAY,
          description: `Connections between nodes. At most ${MAX_EDGES}.`,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              from: { type: SchemaType.STRING, description: "Source node id." },
              to: { type: SchemaType.STRING, description: "Target node id." },
              label: {
                type: SchemaType.STRING,
                description: "Short text such as 'yes' or 'no'; empty if none.",
              },
              dashed: {
                type: SchemaType.BOOLEAN,
                description: "True for optional or asynchronous relationships.",
              },
            },
            required: ["from", "to", "label", "dashed"],
          },
        },
        removedEdges: {
          type: SchemaType.ARRAY,
          description:
            "Existing connections to delete. Needed when inserting a node between two already-connected ones. Empty array otherwise.",
          items: {
            type: SchemaType.OBJECT,
            properties: {
              from: { type: SchemaType.STRING },
              to: { type: SchemaType.STRING },
            },
            required: ["from", "to"],
          },
        },
      },
      required: ["direction", "nodes", "edges", "removedEdges"],
    },

    grid: {
      type: SchemaType.OBJECT,
      description:
        "Fill this only when kind is 'grid': anything arranged in rows and columns. The application draws perfectly even cells, so give only counts and contents.",
      properties: {
        rows: {
          type: SchemaType.INTEGER,
          description: `Number of rows, 1 to ${MAX_GRID_SIDE}.`,
        },
        columns: {
          type: SchemaType.INTEGER,
          description: `Number of columns, 1 to ${MAX_GRID_SIDE}.`,
        },
        style: {
          type: SchemaType.STRING,
          format: "enum",
          enum: ["board", "table"],
          description:
            "'board' draws only the lines between cells, which is what a tic-tac-toe or noughts-and-crosses grid looks like. 'table' outlines every cell.",
        },
        headerRow: {
          type: SchemaType.BOOLEAN,
          description: "Shade the first row, for a table with column headings.",
        },
        cells: {
          type: SchemaType.ARRAY,
          description:
            "Only the cells that have content. Leave the array empty for a blank grid.",
          items: {
            type: SchemaType.OBJECT,
            properties: {
              row: {
                type: SchemaType.INTEGER,
                description: "0-based row index.",
              },
              column: {
                type: SchemaType.INTEGER,
                description: "0-based column index.",
              },
              text: {
                type: SchemaType.STRING,
                description: "Cell contents, e.g. 'X', 'O', or a short label.",
              },
              accent: {
                type: SchemaType.STRING,
                format: "enum",
                enum: NODE_ACCENTS as unknown as string[],
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
      type: SchemaType.OBJECT,
      description:
        "Fill this only when kind is 'sequence': who does what, in order, over time. Lifelines, spacing and label placement are computed for you — give only the participants and the ordered messages.",
      properties: {
        participants: {
          type: SchemaType.ARRAY,
          description: `The actors, left to right in the order they first take part. Two to ${MAX_PARTICIPANTS}.`,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              id: {
                type: SchemaType.STRING,
                description: "Short identifier referenced by messages.",
              },
              label: {
                type: SchemaType.STRING,
                description:
                  "Name shown at the top, e.g. 'Client', 'API', 'Database'. Keep it short.",
              },
              accent: {
                type: SchemaType.STRING,
                format: "enum",
                enum: NODE_ACCENTS as unknown as string[],
                description: "Header colour; 'none' for plain.",
              },
            },
            required: ["id", "label", "accent"],
          },
        },
        messages: {
          type: SchemaType.ARRAY,
          description: `The exchanges, in the order they happen. At most ${MAX_MESSAGES}.`,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              from: { type: SchemaType.STRING, description: "Sender's id." },
              to: {
                type: SchemaType.STRING,
                description: "Recipient's id. The same as 'from' for a self-call.",
              },
              label: {
                type: SchemaType.STRING,
                description:
                  "What is sent, e.g. 'POST /pay (key: 123)' or '200 OK'. Short.",
              },
              kind: {
                type: SchemaType.STRING,
                format: "enum",
                enum: MESSAGE_KINDS as unknown as string[],
                description:
                  "'call' for a request (solid), 'return' for what comes back (dashed), 'self' for work a participant does on its own.",
              },
              section: {
                type: SchemaType.STRING,
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
      type: SchemaType.OBJECT,
      description:
        "Fill this only when kind is 'scene': any other picture or layout. Positions are on a 0-100 square canvas, NOT pixels. 0,0 is top-left; 100,100 is bottom-right.",
      properties: {
        items: {
          type: SchemaType.ARRAY,
          description: `The shapes making up the picture. At most ${MAX_SCENE_ITEMS}. Order matters: later items draw on top.`,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              shape: {
                type: SchemaType.STRING,
                format: "enum",
                enum: SCENE_SHAPES as unknown as string[],
                description: "Which primitive to draw.",
              },
              x: {
                type: SchemaType.NUMBER,
                description:
                  "Left edge, 0-100. For a line or arrow, the start point's x.",
              },
              y: {
                type: SchemaType.NUMBER,
                description:
                  "Top edge, 0-100. For a line or arrow, the start point's y.",
              },
              width: {
                type: SchemaType.NUMBER,
                description:
                  "Width, 0-100. For text, ignored. For a line or arrow, ignored.",
              },
              height: {
                type: SchemaType.NUMBER,
                description:
                  "Height, 0-100. For text this sets the font size, so use about 4 for body text and 8 or more for a heading.",
              },
              x2: {
                type: SchemaType.NUMBER,
                description: "End point x for a line or arrow, 0-100. Else 0.",
              },
              y2: {
                type: SchemaType.NUMBER,
                description: "End point y for a line or arrow, 0-100. Else 0.",
              },
              text: {
                type: SchemaType.STRING,
                description:
                  "For 'text', the words to draw. For a shape, an optional centred label. Empty otherwise.",
              },
              accent: {
                type: SchemaType.STRING,
                format: "enum",
                enum: NODE_ACCENTS as unknown as string[],
                description: "Colour; 'none' draws in the default ink.",
              },
              filled: {
                type: SchemaType.BOOLEAN,
                description:
                  "True to fill the shape with its accent colour rather than leaving it as an outline.",
              },
              rotation: {
                type: SchemaType.NUMBER,
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
  required: ["kind", "title", "summary", "placement"],
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
  refer to existing ones in edges by their exact existing label.`

const SAFETY_SETTINGS = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
].map((category) => ({
  category,
  threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
}));

interface RequestBody {
  prompt?: unknown;
  scene?: unknown;
  /** A data URL snapshot of the canvas. */
  image?: unknown;
  history?: unknown;
}

/**
 * Largest snapshot accepted, as base64 characters. Roughly 3 MB of image, which
 * a 896px-wide PNG stays comfortably under.
 */
const MAX_IMAGE_BASE64 = 4_000_000;

const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * Pull a Gemini inline image part out of a data URL.
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

const parseHistory = (input: unknown): HistoryTurn[] => {
  if (!Array.isArray(input)) {
    return [];
  }

  const turns: HistoryTurn[] = [];

  for (const candidate of input) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const turn = candidate as { role?: unknown; parts?: unknown };
    const role = turn.role === "model" ? "model" : "user";
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
      turns.push({ role, parts: [{ text: text.slice(0, 2000) }] });
    }
  }

  // Gemini requires the transcript to begin with a user turn.
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
  if (!API_KEY) {
    return NextResponse.json(
      { error: "The AI assistant is not configured: GEMINI_API_KEY is unset." },
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

  try {
    const model = new GoogleGenerativeAI(API_KEY).getGenerativeModel({
      model: MODEL_NAME,
      systemInstruction: SYSTEM_INSTRUCTION,
      safetySettings: SAFETY_SETTINGS,
      generationConfig: {
        // Structured output: the reply is JSON matching RESPONSE_SCHEMA.
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
        // Diagram structure should be reproducible, not creative.
        temperature: 0.2,
        maxOutputTokens: 8192,
      },
    });

    const text = [
      image
        ? "The attached image shows the canvas as it looks right now."
        : null,
      `Current canvas:\n${formatSceneForPrompt(scene)}`,
      `Request: ${prompt}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = await model
      .startChat({ history })
      .sendMessage(
        image ? [{ text }, { inlineData: image }] : text,
      );

    const reply = result.response.text();
    let parsed: unknown;

    try {
      parsed = JSON.parse(reply);
    } catch {
      // With a response schema this should not happen; a blocked or truncated
      // reply is the realistic cause.
      const reason = result.response.promptFeedback?.blockReason;
      return NextResponse.json(
        {
          error: reason
            ? `The request was blocked (${reason}).`
            : "The assistant returned an unreadable reply. Please try again.",
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

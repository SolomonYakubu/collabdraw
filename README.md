# CollabDraw

An open-source collaborative drawing application inspired by Excalidraw, built with Next.js and Canvas API. Create beautiful hand-drawn diagrams and collaborate in real-time with others.

## Features

Drawing

- Hand-drawn look via Rough.js, with a stable per-element seed so shapes never
  re-randomise while you work
- Rectangle, diamond, ellipse, arrow, line, freehand and text
- `Shift` constrains: squares/circles, and 15° angle steps for lines and arrows
- `Alt` draws outward from the starting point
- After drawing, the selection tool comes back with the new shape selected —
  unless you turn on the tool lock (`Q`)

Selection and editing

- Click to select, drag a marquee to select many, `Shift`+click to add or remove
- Eight resize handles plus a rotation grip; `Shift` keeps the proportions when
  resizing and snaps rotation to 15°, `Alt` resizes about the centre
- A rotated shape's frame, handles, hit area and snap points all turn with it, and
  resizing one keeps the corner you are not dragging exactly where it was
- Alignment guides with snapping (hold `Ctrl`/`Cmd` while dragging to bypass)
- `Alt`+drag duplicates; arrow keys nudge (`Shift` for larger steps)
- Clicking the hollow middle of an unfilled shape passes through to whatever is
  behind it, as in Excalidraw

Connections

- **Lines stay where you put them; arrows attach to shapes.** That split is what
  makes geometry possible — a line drawn corner to corner is not dragged onto the
  shape's edge
- **Endpoints snap to corners, edge midpoints, centres and other lines' ends**, so
  joining vertices lands exactly; a crosshair shows what has been grabbed, and
  holding `Shift` turns it off
- Arrows bind to shapes as you draw, snapping to the edge before you let go; the
  candidate shape is highlighted
- Three shapes of connector: **straight**, **curved**, and **elbow** —
  right-angled with rounded corners, which routes _around_ the shapes it joins
  and threads gaps between them rather than cutting through
- Bound arrows follow their shapes when those move or resize, sliding around the
  outline and keeping a small gap; elbows re-route as they go
- Pull a bend out of a line by dragging the handle in the middle of a segment;
  alt-click a bend to remove it
- Drag an endpoint to re-bind it to another shape, or away to release it
- Deleting a shape releases the arrows attached to it

Erasing

- The eraser previews what it is about to remove and commits on release, so one
  stroke is one undo step
- Hold `Alt` while erasing to restore something you just marked
- Hit detection follows the path the pointer travelled, so fast strokes do not
  skip shapes

Text

- Real `<textarea>` editing: caret, selection, clipboard, IME and mobile
  keyboards all work
- Double-click a shape to add a label that stays centred and wraps inside it
- Double-click empty canvas for free-standing text

Canvas

- Infinite canvas; `Ctrl`/`Cmd`+wheel zooms about the cursor, wheel scrolls
- Space+drag, middle-mouse drag, or the hand tool (`H`) to pan
- Undo/redo, z-order, copy/paste/duplicate, PNG export
- Real-time collaboration: live cursors, in-progress shapes, shared scene

AI drawing

- Ask for it in words. Four kinds of thing are understood, and the assistant
  picks the one that fits the question:
  - **sequences** — who does what in order: how idempotency works, OAuth, a
    TCP handshake. Lifelines and message spacing are computed, so they line up
  - **scenes** — pictures and spatial figures: a house, a pendulum with its
    forces labelled, a UI mock-up, a floor plan
  - **grids** — tic-tac-toe and other game boards, tables, calendars, matrices
  - **diagrams** — architectures, org charts, state machines, process steps
- It says where its output goes — extending what you have, sitting beside it, or
  replacing it — so a new rendering is never stacked on top of the old one
- The model returns _structure_, never coordinates; the app does the layout, sizes
  every box to its label, and draws the connectors — so nothing overlaps and
  nothing lands off-screen
- Generated arrows are ordinary bound arrows, so dragging a node moves them too
- It sees what is already on the canvas — both as structure and as a picture, so
  it can read freehand sketches too — and builds on it:
  - "your turn" plays into the _existing_ board rather than drawing a new one
  - "complete this" adds to the drawing you started, in place
  - "add a Redis cache between the API and the database" attaches to the nodes
    already there and retires the link it replaced
- It can tilt things, and it is told about rotations already on the canvas

## Keyboard shortcuts

|                                |                                     |
| ------------------------------ | ----------------------------------- |
| `V` / `1`                      | Selection                           |
| `H`                            | Hand (pan)                          |
| `R` / `2`                      | Rectangle                           |
| `D` / `3`                      | Diamond                             |
| `O` / `4`                      | Ellipse                             |
| `A` / `5`                      | Arrow                               |
| `L` / `6`                      | Line                                |
| `P` / `7`                      | Draw                                |
| `T` / `8`                      | Text                                |
| `E` / `0`                      | Eraser                              |
| `Q`                            | Keep the current tool after drawing |
| `Space`+drag                   | Pan                                 |
| `Ctrl`/`Cmd`+`Z` / `Shift`+`Z` | Undo / redo                         |
| `Ctrl`/`Cmd`+`A`               | Select all                          |
| `Ctrl`/`Cmd`+`D`               | Duplicate                           |
| `Ctrl`/`Cmd`+`C` / `X` / `V`   | Copy / cut / paste                  |
| `Ctrl`/`Cmd`+`]` / `[`         | Bring forward / send backward       |
| `Ctrl`/`Cmd`+`Shift`+`]` / `[` | Bring to front / send to back       |
| `Ctrl`/`Cmd`+`+` / `-` / `0`   | Zoom in / out / reset               |
| `Shift`+`1`                    | Zoom to fit                         |
| `Delete`                       | Delete selection                    |
| `Escape`                       | Cancel or deselect                  |

## Getting Started

### Prerequisites

- Node.js 18.0 or later
- npm or yarn

### Installation

1. Clone the repository:

```bash
git clone https://github.com/yourusername/collabdraw2.git
cd collabdraw2
```

2. Install dependencies:

```bash
npm install
# or
yarn install
```

3. Run the development server:

```bash
npm run dev
# or
yarn dev
```

4. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Project structure

```
app/
├── types/            Element and collaboration types
├── utils/            geometry.ts (pure maths), viewport.ts (the one transform)
├── services/canvas/  elements, hitTest, linearElement, elbowRouter, bindings,
│                     pointSnapping, boundText, transform, snapping,
│                     textMeasure, renderer, hydration
├── services/ai/      intent, graph, grid, scene, layout, build, buildScene,
│                     describeScene
├── hooks/canvas/     useScene, useViewport, usePointerInteraction,
│                     useTextEditor, useKeyboardShortcuts, useAIAssistant,
│                     useBoardPersistence, useLocalSceneAutosave
├── context/          CollaborationContext (socket transport)
├── lib/              db.ts (Postgres), boardAccess.ts (device cookie, limits)
├── components/       Canvas.tsx, Dashboard.tsx and canvas/ (surface, overlays, UI)
├── page.tsx          the canvas — the app's front door
├── board/[id]/       a room: shared scene, live collaboration
├── boards/           the gallery of boards saved to the cloud
└── api/              generate-drawing (AI endpoint), boards/* (persistence)
middleware.ts         issues the anonymous `cd_device` cookie
migrations/           numbered .sql schema migrations
scripts/migrate.mjs   migration runner (npm run db:migrate)
server/               Socket.IO backend service (realtime collaboration)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for how these fit together and the
invariants that keep them consistent.

## Running it

Both processes together:

```bash
npm run dev:all      # Next.js on :3000 and the socket server on :3001
```

Or separately with `npm run dev` and `npm run server`. Collaboration is
optional — with the socket server down the editor works locally and shows
"Offline".

### Where your drawing lives

Opening the app puts you on a canvas with your last drawing already on it. That
needs no account and no database: the scene is kept in this browser
(`localStorage.collabdraw_scene`, written on a 300 ms debounce and flushed when
the tab goes away), the way excalidraw.com works.

Everything else is a choice in the main menu, top-left:

| Menu item | What it does |
|---|---|
| Open… / Save to file | A `.collabdraw` document — the scene, portable. |
| Export as image | PNG of the current scene. |
| Save to my boards | Creates a board in Postgres and moves you to `/board/<id>`. |
| Rename board… | In a room, where "Save to my boards" would be: the board is already saved, so the menu offers its name instead. The canvas itself carries no title field. |
| My boards | `/boards`, the gallery of what you have saved. |
| Live collaboration | Starts a room from the drawing on screen and hands you a share link. |

Live collaboration needs neither an account nor a saved board: the share button
in the toolbar mints a room, carries your current scene into it, and the socket
server holds the shared scene from there. Leaving the room leaves your local
canvas as it was — while you are in a room the browser copy is left alone, so a
room can never overwrite your solo drawing (the same lock Excalidraw takes).
Who else is in the room is behind the people button in the toolbar — a click
shows the list, and nothing sits on the canvas the rest of the time.

### Boards and the database

`/board/<id>` is a room whose scene is also stored in Postgres (Neon), so it
survives a reload, a socket-server restart and an expired Redis snapshot.

Point `.env` at a database and apply the schema once:

```bash
# Neon (or any managed Postgres) — from the project's connection details.
# verify-full rather than Neon's default `require`: identical behaviour in pg 8,
# and it silences pg's warning that the two will diverge in v9.
DATABASE_URL=postgres://user:pass@ep-xxx-pooler.region.aws.neon.tech/dbname?sslmode=verify-full
DATABASE_URL_UNPOOLED=postgres://user:pass@ep-xxx.region.aws.neon.tech/dbname?sslmode=verify-full

# …or a local server, where there is no certificate to verify:
DATABASE_URL=postgres://$(whoami)@localhost:5432/collabdraw?sslmode=disable

npm run db:migrate   # applies migrations/*.sql, tracked in schema_migrations
```

Then confirm it before touching the UI:

```bash
npm run db:check     # connects, names the server, checks the tables exist
```

TLS is chosen from the connection string — verified for a remote host, skipped
for `localhost`/`127.0.0.1` or an explicit `sslmode=disable`, and unverified only
with `sslmode=no-verify` (a host behind a private CA). `npm run dev`,
`npm run server`, `npm run db:migrate` and `npm run db:check` all read `.env`, so
a new string reaches the app and the socket server on their next restart. Both
processes need it: the app renders the board, the socket server writes the merged
scene.

Without `DATABASE_URL` everything except cloud saving still works: the canvas
draws, autosaves locally, exports, and collaborates. The board layer never
attempts a connection — it fails fast with `DatabaseNotConfiguredError`, so
"Save to my boards" answers with a plain "not configured on this deployment"
(503) instead of a 500, and `/boards` says the store is unreachable rather than
showing an empty gallery.

Ownership is anonymous: a `cd_device` cookie issued by `middleware.ts` marks the
boards you created, and a board opened through someone else's share link joins
your gallery too. Anyone with the link can edit — there is no per-board access
control yet.

### Environment

```
GEMINI_API_KEY=...          # server-side only, for the AI endpoint
GEMINI_MODEL=...            # optional model override
NEXT_PUBLIC_SOCKET_URL=...  # defaults to http://localhost:3001
DATABASE_URL=...            # Neon pooled string, used by the app and socket server
DATABASE_URL_UNPOOLED=...   # direct string, used only by npm run db:migrate
```

## Tests

```bash
npm test
```

Vitest covers the pure layers — geometry, the viewport transform, element
construction, hit testing, bindings, linear elements, the elbow router,
transforms, snapping and the AI intent/layout/build pipeline — plus the renderer
itself through node-canvas.

Not yet covered: the socket server (`server/`), every React component, hook and
context under `app/`, and the API routes — see [#14](https://github.com/SolomonYakubu/collabdraw/issues/14)
and [#15](https://github.com/SolomonYakubu/collabdraw/issues/15).

## Contributing

We welcome contributions! Here's how you can help:

1. Fork the repository
2. Create a feature branch:

```bash
git checkout -b feature/amazing-feature
```

3. Make your changes
4. Run tests (if available) and ensure code quality:

```bash
npm run lint
npm run test
```

5. Commit your changes:

```bash
git commit -m 'Add amazing feature'
```

6. Push to your branch:

```bash
git push origin feature/amazing-feature
```

7. Open a Pull Request

### Development Guidelines

- Follow the existing code style
- Write meaningful commit messages
- Add comments for complex logic
- Update documentation when needed
- Test your changes thoroughly

### Code Style

- Use TypeScript for type safety
- Follow the [React Hooks guidelines](https://reactjs.org/docs/hooks-rules.html)
- Maintain component modularity
- Use meaningful variable and function names

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Inspired by [Excalidraw](https://excalidraw.com/)
- Built with [Rough.js](https://roughjs.com/) for sketchy rendering
- Uses [Next.js](https://nextjs.org/) for the framework
- Real-time features powered by Socket.io

## Support

For support, please open an issue in the GitHub repository.

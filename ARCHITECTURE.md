# CollabDraw Architecture

The editor is split so that each concern has exactly one implementation. That
was the main problem with the previous structure: pointer handling, hit testing
and screen↔world maths each existed in three places that disagreed with one
another.

## Layers

```
app/
├── types/shapes.ts              The element model. One source of truth.
├── utils/
│   ├── geometry.ts              Pure maths: distances, hit shapes, ray casts.
│   └── viewport.ts              THE screen ↔ world transform.
├── services/canvas/
│   ├── elements.ts              Create / mutate / translate / resize elements.
│   ├── hitTest.ts               What is under a point; transform handles.
│   ├── linearElement.ts         Where a line's ends land and what path joins them.
│   ├── elbowRouter.ts           Orthogonal routing around obstacles (A*).
│   ├── pointSnapping.ts         Snapping a point to corners, midpoints, ends.
│   ├── bindings.ts              Arrow ↔ shape connection records.
│   ├── boundText.ts             Labels living inside a container shape.
│   ├── transform.ts             Resizing a selection from a handle.
│   ├── snapping.ts              Alignment guides and snap offsets.
│   ├── textMeasure.ts           Text metrics and wrapping.
│   ├── hydration.ts             Whether a join's scene may replace the local one.
│   └── renderer.ts              Draws the scene onto the two canvases.
├── services/ai/
│   ├── intent.ts                Which kind of drawing, and where it goes.
│   ├── graph.ts                 Diagram contract: nodes and edges.
│   ├── grid.ts                  Grid contract: rows, columns, cells.
│   ├── sequence.ts              Sequence contract: participants and messages.
│   ├── scene.ts                 Scene contract: items on a 0-100 canvas.
│   ├── layout.ts                Deterministic layered layout for diagrams.
│   ├── buildScene.ts            Diagram → elements with bound arrows.
│   ├── build.ts                 Dispatch, plus the grid and scene builders.
│   └── describeScene.ts         Canvas → description, for continuing work.
├── hooks/canvas/
│   ├── useScene.ts              Elements + undo/redo + change broadcasting.
│   ├── useViewport.ts           Zoom, scroll, canvas sizing, wheel.
│   ├── usePointerInteraction.ts The pointer state machine.
│   ├── useTextEditor.ts         Text editing state.
│   ├── useKeyboardShortcuts.ts  Key bindings.
│   └── useAIAssistant.ts        The AI diagram endpoint.
├── hooks/canvas/useBoardPersistence.ts  Thumbnails, open-records, offline flush.
├── hooks/canvas/useLocalSceneAutosave.ts  The no-account tier: localStorage.
├── services/canvas/localScene.ts    Read/write the browser's copy of the scene.
├── services/canvas/sceneFile.ts     The .collabdraw document format.
├── services/collaboration/identity.ts  Your presence id and editable display name.
├── lib/
│   ├── db.ts                    Postgres pool and the board queries. Throws
│   │                            DatabaseNotConfiguredError when there is no
│   │                            DATABASE_URL, so the app runs without a
│   │                            cloud tier instead of failing to connect.
│   └── boardAccess.ts           Device cookie and payload size limits.
├── context/CollaborationContext.tsx   Socket transport only.
├── page.tsx                     The canvas. The front door.
├── board/[id]/                  A room: loads the board, mounts collaboration.
├── boards/                      The gallery of cloud-saved boards.
└── components/
    ├── Canvas.tsx               Wires the above together. Owns UI state.
    ├── Dashboard.tsx            The gallery UI: cards, per-card menu, search.
    ├── ui/                      Modal, ConfirmDialog, PromptDialog, Toast —
    │                            the app's only ask-and-tell surfaces. Nothing
    │                            calls window.confirm/prompt/alert.
    └── canvas/
        ├── CanvasSurface.tsx    The two <canvas> elements.
        ├── TextEditorOverlay.tsx  A real <textarea> over the element.
        ├── RemoteCursors.tsx    Collaborator cursors.
        └── ui/                  MainMenu, Toolbar, CollaboratorsButton,
                                 StylePanel, ContextMenu, ZoomControls.
```

## The three rules that keep it honest

## Production topology

The realtime server supports a single local process without Redis, but a
production deployment should set `REDIS_URL` and `REQUIRE_REDIS=true`:

```
browser -> Next.js app -> /api/generate-drawing
  |                         |
  |                         +-> /api/boards/* ----+
  |                                               |
  +-> Socket.IO x N --------+-> Redis (adapter + room snapshots)
                  |         |
                  |         +-> Postgres (Neon) — durable boards
                  |
                  +-> BullMQ -> dedicated AI workers
```

Socket.IO's Redis adapter broadcasts events between server instances. Canvas
snapshots are stored with a 24-hour TTL so reconnects and rolling deploys do
not lose the latest state. BullMQ is reserved for background, non-streaming AI
requests; the current streaming endpoint remains a request/response path.
The queue requires an application-specific processor module via
`GENERATION_PROCESSOR_MODULE`, so provider credentials never enter a browser
payload or a Socket.IO event.

Run the worker as a separate process with `npm --prefix server run worker`.
Use a managed Redis service in production, configure `REQUIRE_REDIS=true`, and
keep the web and worker processes on the same Redis instance. The queue is not
used for streamed responses because putting a live stream behind a durable job
would add latency and require a second progress transport.

**1. One coordinate transform.** `utils/viewport.ts` defines

```
screenCss = (world + scroll) · zoom
world     = screenCss / zoom - scroll
```

`applyViewportTransform` applies exactly this (times the device pixel ratio) as
a canvas transform, and `clientToWorld` inverts it for pointer events. Because
rendering and input share one definition, they cannot drift apart. A test
asserts the renderer's matrix agrees with the pointer maths.

**2. Elements are immutable and carry a stable `seed`.** Every mutation goes
through `mutateElement`, producing a new object. The seed makes rough.js emit
identical geometry every frame — without it, shapes re-randomised their sketch
on each redraw and visibly crawled. Immutability also gives the renderer a free
cache: drawables are stored in a `WeakMap` keyed by the element object, so an
untouched element is never re-tessellated.

**3. Scene changes go through `applyElements`.** It computes the next array from
a synchronously-maintained ref, pushes that exact array onto the history stack,
and reports what changed so collaborators can be told. Callers never write
elements and record history separately, which is how the old code ended up
recording the state _before_ each change.

## Rendering

Two stacked canvases, as in Excalidraw:

- **static** — the elements. Repaints when the scene, viewport or size changes.
- **interactive** — selection box, transform handles, alignment guides, binding
  highlight, marquee, eraser trail. Cheap, so hover feedback costs nothing.

Both repaint inside a single `requestAnimationFrame`, so a burst of pointer
events produces one frame of work. Off-screen elements are culled.

## Input

`usePointerInteraction` is a state machine over pointer events:

```
idle → panning | drawing | freedraw | marquee | pendingDrag → dragging
     | resizing | endpoint | erasing
```

State lives in a ref (a fast pointer stream must not read a stale closure);
only what the interactive layer draws is mirrored into React state. Pointer
capture is taken on pointerdown, so releasing outside the canvas ends the
gesture properly instead of leaving the editor stuck mid-draw.

## Rotation

Every element carries an `angle`, and the trick that keeps rotation from spreading
through the whole codebase is a single pair of mappings in `elements.ts`:

```
toElementLocal(worldPoint, element)    // world  -> the element's own frame
fromElementLocal(localPoint, element)  // and back
```

An element's _stored_ geometry — `x/y/width/height`, `points`, `x1..y2`, `route` —
always lives in its unrotated frame; the angle is applied to the canvas context at
draw time. So hit testing, point snapping and binding all convert the point first
and then reuse the existing unrotated maths untouched. There is no rotated variant
of any outline test.

Two notions of bounds, and picking the wrong one is the easy mistake:

- `getElementBounds` — the element's own unrotated box. Used for its geometry.
- `getRotatedBounds` — the axis-aligned box it occupies on screen. Used wherever
  a screen rectangle is meant: culling, marquee selection, multi-select hulls.

A single selected element's frame and handles **turn with it**, which is what makes
a tilted shape feel like an object rather than a picture in a box; a mixed selection
has no single angle, so its handles stay upright. The rotation grip stands off the
top edge, and shift snaps to 15°.

### Resizing something rotated

The pointer is mapped back into the element's frame before the box maths runs.
That alone is not enough: the element turns about the centre of its own box, so
changing the box moves that centre and the corner you are _not_ dragging drifts.
`applyRotatedResize` cancels it exactly, by translating the result by
`(R(θ) − I)·Δcentre` — independent of which handle is in use. The tests assert the
anchored corner does not move, at several angles, for corner and side handles.

## Hit testing

An element with a transparent background is hit only _near its stroke_, so
clicking the hollow middle of a rectangle selects whatever is behind it. Filled
elements are hit anywhere inside. Ellipses and diamonds use real geometry, not
their bounding boxes. Thresholds are given in screen pixels and divided by the
zoom, so the grab area is constant on screen.

## Connections

A line or arrow gets its shape from three things, folded together by
`refreshLinearElement` into a stored `route` — the polyline that the renderer,
the bounds and the hit test all read:

1. **Its ends.** A bound end stores `{ elementId, focus, gap }`, where `focus` is
   an anchor inside the shape normalised to ±0.5 on each axis, so it survives
   both moves and resizes.
2. **Its waypoints.** Bends the user pulled out of it.
3. **Its route.** For an elbow, the orthogonal path computed around the shapes
   it connects.

`route` is stored rather than derived on demand so that bounds, culling and hit
testing stay pure functions of a single element — an elbow's detour is inside
its own bounding box, and the whole bent length is grabbable.

### Lines do not bind; arrows do

Only an **arrow** attaches itself to a shape. A **line** stays exactly where it is
put.

This distinction matters more than it sounds. Binding moves an endpoint onto the
nearest outline and stands it off by the binding gap — exactly right for a
connector, and exactly wrong for geometry. With lines binding too, drawing a cube
was impossible: every line started from a corner got dragged off it, so the
corners never met. Excalidraw draws the same line, for the same reason.

### Point snapping

`pointSnapping.ts` snaps a single point onto the significant points of nearby
elements: corners, edge midpoints, centres, and the ends of other lines. It runs
while a line or arrow is drawn, while an endpoint is dragged, and while a
waypoint is moved, so corner-to-corner joins land exactly rather than
approximately. A crosshair marks the point that has been grabbed.

Holding shift stands snapping aside, because shift means the angle is being
constrained deliberately.

Diamonds contribute their four points rather than their bounding box's corners,
and ellipses contribute their quadrant points but no corners — snapping to a
place where the shape is not would be worse than not snapping at all.

### Edge styles

- **straight** — direct segments through the waypoints.
- **curved** — a smooth rough.js curve through the same points.
- **elbow** — right-angled segments with rounded corners, routed around
  obstacles. Bound elbow ends leave from the _middle of a side_, chosen by
  `getFacingHeadings`, which is what makes a grid of connectors line up.

### Routing

`elbowRouter.ts` builds a sparse grid from the interesting coordinates —
obstacle edges plus their clearance, the endpoints, and the corridor between two
obstacles — then runs A\* across it with a penalty per turn. A sparse grid keeps
it to a couple of hundred nodes, so it runs comfortably inside a pointer-move.
Obstacles are the two bound shapes plus any bindable shape sitting in the
corridor between the ends, capped for predictable cost.

Two things the tests pin down: a route never crosses a shape it is bound to, and
re-resolving is **idempotent** — the same route comes back every time, which is
what stops a drag from jittering.

### Behaviour

- Drawing an arrow binds it provisionally as you drag, so it snaps to a shape's
  edge and an elbow bends into place before you release. The candidate shape is
  highlighted.
- Moving or resizing a shape drags its arrows with it (`updateBoundElements`).
- Dragging an arrow itself does _not_ re-solve its own bindings mid-gesture —
  otherwise it would snap back every frame and could never be moved. On release,
  `settleBindingsAfterMove` releases the ends that left their shapes and snaps
  back the ones that did not.
- A selected straight or curved line shows a handle per waypoint plus a phantom
  handle mid-segment; dragging a phantom pulls out a new bend, alt-clicking a
  waypoint removes it, and dropping one back onto the straight line drops it.
- Deleting a shape clears the bindings that referenced it and rebuilds the
  affected routes (`removeStaleBindings`).

## AI generation

The model returns a **structured description**, never pixel coordinates:

```
prompt + canvas description  ->  model (enforced JSON schema)  ->  intent
intent  ->  builder for its kind  ->  ordinary elements
```

### Four kinds

| kind       | for                                                                      | contract                           |
| ---------- | ------------------------------------------------------------------------ | ---------------------------------- |
| `sequence` | who does what in order: how idempotency works, OAuth, a handshake        | participants + ordered messages    |
| `scene`    | pictures and spatial layouts: a house, a pendulum with forces, a mock-up | items on a normalised 0-100 canvas |
| `grid`     | rows and columns: game boards, tables, calendars, matrices               | counts + cell contents             |
| `diagram`  | abstract things connected to abstract things, with no time axis          | nodes + edges, laid out in layers  |

The first version had only `diagram`, so every request came back as a block
diagram. Each kind added since is one the model was previously forced to
hand-build out of a free scene — a sequence diagram in particular meant lifelines
placed by eye and labels colliding, when participants-and-ordered-messages is as
structured as a grid.

`kind` is treated as a hint rather than gospel: whichever payload actually has
content wins, because models sometimes name one kind and fill another. The
routing guidance leads with the _question being asked_ rather than the kinds,
because "how does X work" pattern-matched to "process steps" and produced a
flowchart when a sequence diagram was wanted.

### Placement

The model states where its output goes — `add`, `beside` or `replace` — rather
than the server inferring it.

That inference was a keyword regex over the prompt, and it failed on the case
that matters. Asked for "something beyond a flowchart", the model returned a
sequence diagram whose own summary said it had _replaced_ the flowchart; the
prompt matched none of `clear|reset|start over`, so the reply was forced to be
additive, and a scene marked additive is anchored onto the existing drawing's
box — so it was drawn straight on top of it. The model knew its intent all
along; it had nowhere to say so.

`add` is the only placement that anchors onto existing content, which is what
"finish this" needs. `beside` and `replace` both get clear space. Tests assert
that the last two never overlap what is already drawn.

### Why it is split this way

- **No JSON to repair.** `responseSchema` guarantees the reply's shape, retiring
  ~250 lines of bracket-counting and quote-fixing that existed only because the
  old prompt asked for JSON inside prose.
- **No coordinates to get wrong.** Even a `scene` is normalised and clamped, so a
  confused reply produces a squashed drawing rather than shapes off-screen. This
  retired ~600 lines of grid snapping, overlap resolution and connector
  re-anchoring that tried to repair bad geometry afterwards.
- **Layout runs on the client**, where text can be measured exactly and the
  binding machinery already lives. Generated edges are real bound arrows, so an
  AI diagram behaves like a hand-drawn one.
- **Builders emit ordinary elements**, so everything generated is selectable,
  editable and undoable like anything else.

### Continuing what is already there

Each request carries the canvas **twice**: as a picture, and as a structured
description.

The picture matters because no description can convey a freehand stroke —
`freehand at (0,86) size 17x14` says nothing about what was drawn. The model is
multimodal, so it gets a bounded PNG snapshot (longest side 896px, rendered by
`exportSceneToDataURL`) and can simply look. Asked "what shape is drawn here?"
over a freehand triangle, it answers "triangle".

The description carries what the picture cannot: exact coordinates, node names,
and cell indices to build on. `describeScene` renders it three ways at once — as
a graph, as a detected grid, and as items in the same 0-100 frame the model
writes — and the model uses whichever fits.

This is the part the first version got wrong. It described _only_ labelled
container shapes and bound arrows, so a tic-tac-toe board (lines plus loose text)
and a half-finished sketch (plain boxes plus loose text) both collapsed into an
"N other elements" count. The model was effectively told the canvas was empty and
started over every time: a new board appeared with every move.

Now:

- **Grids are detected geometrically** — evenly spaced separator lines, or a
  lattice of equal rectangles — so a board is recognised whether it was generated
  or drawn by hand, along with the marks in its cells. A reply naming the same
  rows and columns is written into that board _in place_: unchanged marks are left
  alone, changed ones replaced, cleared ones deleted. That is what lets a game be
  played turn by turn.
- **Scene additions are anchored** to the box the existing drawing occupies, so
  "complete this" lands on the drawing instead of beside it.
- **Diagram additions** name existing nodes by label, bind to them for real, and
  can retire the edge they replace via `removedEdges`.

Two guards worth knowing about: an edge may reference a node that exists only on
the canvas (without that, every incremental connection looked like a dangling edge
and was discarded), and `replaceCanvas` is ignored on a non-empty canvas unless
the prompt actually asks to start over — models set it far too eagerly, and it is
the one destructive thing the endpoint can do.

## Collaboration

`CollaborationContext` is transport only: it owns the socket, the participant
list and remote cursors, and forwards scene messages to handlers the editor
registers. It does not own the element list, so there is one source of truth.

- A full scene sync becomes the new history baseline.
- Remote element updates are applied without being re-broadcast, which is what
  caused the old update storms.
- Cursors travel in **world** coordinates and are projected locally, so a
  cursor lands on the same part of the drawing for everyone regardless of each
  person's zoom.
- `server/` (Socket.IO backend service, port 3001) relays messages and keeps
  the last known scene per room so a later joiner gets the drawing.

## Persistence

**The front door is the canvas, and it needs nothing.** `/` renders the editor
with the last scene restored from `localStorage.collabdraw_scene` — no account,
no board, no database. This is excalidraw.com's model, copied deliberately:
`localScene.ts` owns the format (one versioned key holding elements plus
viewport, read back through `restoreElements` so a corrupt entry degrades to an
empty scene instead of throwing), and `useLocalSceneAutosave` owns the cadence —
a 300 ms debounce (Excalidraw's `SAVE_TO_LOCAL_STORAGE_TIMEOUT`), skipped while
the tab is hidden, flushed on `pagehide`, on hide, and on unmount.

**Saving locally stops inside a room.** With a `boardId` present the autosave is
disabled, because the socket server then holds the authoritative merged scene and
a second, staler copy would only fight it. Excalidraw does this with a
`"collaboration"` save lock, for the same reason. The consequence users feel is
the important part: joining a room never overwrites the drawing you had at `/`.

**Live collaboration is not a saved board.** The share button mints a room id in
the browser, flushes the local scene, and navigates to `/board/<id>?adopt=local`;
the room adopts that scene through the empty-sync rule below. No account and no
database are involved — those are what "Save to my boards" adds.

A board is one row in Postgres: `boards.scene` holds the `Shape[]` as `jsonb`,
alongside queryable metadata (title, owner, counts, timestamps). The board id
_is_ the room id, so persistence is metadata attached to a room rather than a
second concept. Thumbnails and the "boards I have opened" relation live in their
own tables — a 50-board gallery would otherwise drag megabytes of data URLs
through every list query.

**Three tiers, one direction.** In-memory room state is the fast path, Redis is
a 24-hour hot cache, Postgres is the store of record. A join hydrates from the
first of those that has something (`roomHandler`), and the client also renders
its own database read from the `/board/[id]` server component, so a board is on
screen before the socket has finished connecting.

**One writer at a time.** The socket server holds the merged authoritative
scene, so it does the writing: `scheduleFlush` coalesces edits and writes Redis
and Postgres once they settle (3s), with a forced flush when a room empties and
on `SIGINT`/`SIGTERM`. This replaced re-serialising the whole room to Redis on
every stroke. The client writes the scene only when the socket is _disconnected_
— a `sendBeacon` on `pagehide` — so the two writers do not race in practice; the
server's next flush would correct it anyway. Title and thumbnail are separate
columns written only by the client, so metadata never touches `scene`.

**The empty-sync trap.** A board hydrated from the database joins a room whose
server cache may be empty, and the server answers the join with an empty scene.
Adopting it would blank the board. `services/canvas/hydration.ts` states the
rule — refuse an empty hydration when the local scene is non-empty, and push the
local scene up to seed the room instead — and it is unit-tested, because getting
it wrong loses drawings intermittently rather than loudly. Live full updates (a
peer's clear or undo) arrive on a different handler and are always applied. The
same rule is what carries a local drawing into a freshly started session.

**Degrading without a database.** `DATABASE_URL` is optional, and the pool is
created on first use: with no connection string the board layer throws
`DatabaseNotConfiguredError` instead of dialling `pg`'s default localhost, which
failed as a message-less `AggregateError` and — replayed out of a Server
Component — read as a crash. The pool binds a `pool.on("error")` listener because
`pg` emits that on _idle_ clients and an unhandled `error` event takes the process
down. Beyond that, every read path already logs and falls back (an empty scene, an
empty gallery); the write path answers `503` with a message naming the limitation,
rather than a silent failure that looks like a broken button.

**Ownership** is an anonymous `cd_device` cookie issued by `middleware.ts`, and
that cookie is the only writer of board ownership —
`localStorage.collabdraw_userId` is the collaboration presence id and is
deliberately kept separate. Middleware sets a new id on the *request* as well as
the response, so the board created while rendering a first-ever share-link visit
is stamped with the visitor's real id.

**Your display name** is the third id, and the only one you can edit:
`localStorage.collabdraw_userName`, owned by `services/collaboration/identity.ts`.
It is deliberately not `cd_device` (that would tie a name you can change to a
claim you cannot) and not `collabdraw_userId` (nothing displays that). It used to
be minted on every mount, so the label over your cursor was a different random
animal after each reload and nobody could learn who you were.

Renaming goes three places at once: localStorage, the `identityRef` that stamps
outgoing `cursor-position` messages, and the server's roster via
`update-user-name`. That handler takes the user id from `socket.data`, never from
the payload — reading it off the wire would let any client rename anybody else in
the room — and re-broadcasts `active-users`, which the client also uses to
relabel peers' cursors so a rename shows up without waiting for their next
pointer move. The name is held in a ref rather than a dependency of the socket
effect, because reconnecting on every rename would drop everyone's cursors and
re-run hydration for a change of label. It is editable in two places: the field
at the top of the collaborator list, and a main-menu item — the people button
only exists in a room, and the name you want is the one you set *before* sharing.

Opening an unknown id creates the board (`insert ... on conflict do nothing`) so
old share links and collaborators' links never 404. Only a caller with a real
device id creates a row: the socket server's scene flush is an `update`, never an
upsert, because that process has no cookie and its placeholder owner (`"server"`)
produced boards nobody could rename or delete. Rows already stamped that way are
treated as unclaimed — `mayWriteBoardMetadata` lets any real device write to one,
and `claimBoard` takes ownership on the way through, guarded in SQL so a board
that already has an owner can never be stolen.

## Tests

`npm test` runs Vitest over the pure layers: geometry, the viewport transform,
element construction, hit testing, bindings, linear elements, the elbow router,
transforms, snapping, the AI intent/layout/build pipeline (including grid
detection and playing a turn on an existing board), and the renderer itself (via
node-canvas, including a determinism check that the same scene renders
byte-identically twice).

Not covered: the socket server (`server/`), every React component, hook and
context under `app/`, and the API routes — see [#14](https://github.com/SolomonYakubu/collabdraw/issues/14)
and [#15](https://github.com/SolomonYakubu/collabdraw/issues/15).

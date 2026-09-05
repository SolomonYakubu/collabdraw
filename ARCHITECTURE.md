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
├── hooks/canvas/useBoardPersistence.ts  Thumbnails, open-records, flush on leaving.
├── hooks/canvas/useLocalSceneAutosave.ts  The no-account tier: localStorage.
├── hooks/useEditorPreferences.ts    The pen and the tool lock, remembered.
├── services/canvas/localScene.ts    Read/write the browser's copy of the scene.
├── services/canvas/reconcileLocalScene.ts  Merge another tab's scene into this one.
├── services/canvas/preferences.ts   Read/write the stored pen and tool lock.
├── services/storageSync.ts          Hearing another tab write localStorage.
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
the tab is hidden, flushed on `pagehide`, on hide, and on unmount. The copy is
close but not wholesale, and where it stops is a list of its own at the end of
this tier.

**A refused write is not the same as a saved one.** `localStorage` throws when
the quota is full, and for this tier that means the drawing exists in this tab and
nowhere else — worth saying rather than logging. `saveLocalScene` answers with a
boolean instead of throwing, and the hook reports the *change* in that answer
through `onSaveOutcomeChange`: false the first time a write is refused, true again
once one succeeds. Edge-triggered on purpose, a full quota failing on every 300 ms
tick and one toast per tick being unreadable. The canvas turns it into a sticky
error naming the way out ("use Save to file to keep it") and clears it when saving
recovers. Two actions are refused outright instead, both of them handing the
stored entry to somebody else: starting a session, where the room reads the scene
back out of `localStorage` and a refused write would open an empty room with the
drawing stranded behind it, and leaving one with _Keep a copy_.

**Resetting has to stay reset.** "Reset the canvas" removes the entry, but
emptying the canvas is a change like any other, so the debounce would write an
empty one back 300 ms later — which is why the clearing belongs to the autosave
(`clearSavedScene`) rather than to `clearLocalScene` alone: it removes the key and
then declines to save until something is drawn again. In a room it declines
outright, the stored scene there being the solo drawing left behind. The entry
carries no timestamp: one was written for a "restored from your last session"
notice that was never built, and this tier exists so that opening the app is not
an event worth announcing.

**Saving locally stops inside a room.** With a `boardId` present the autosave is
disabled, because the socket server then holds the authoritative merged scene and
a second, staler copy would only fight it. Excalidraw does this with a
`"collaboration"` save lock, for the same reason. The consequence users feel is
the important part: joining a room never overwrites the drawing you had at `/`.

**Leaving asks, because both copies are somebody's work.** The autosave being off
means the entry in this browser is still the drawing from _before_ you shared, so
walking back to `/` restored that one and everything drawn in the room was simply
not on this device — the board still had it, but nothing said so and nothing
offered to keep it. Excalidraw solves the same problem in the other direction: it
writes the room's scene over the local one with no prompt, losing the pre-session
drawing instead, which its own tracker calls possibly unexpected
([excalidraw#909](https://github.com/excalidraw/excalidraw/issues/909)). Neither
copy is obviously the one to discard, so "Leave the room…" — a main-menu item that
exists only while `isCollaborative` — asks, with three answers rather than two:
_Keep a copy_ (overwrite the local entry with the room's scene), _Leave without
keeping_, and _Stay_. That is the one thing `confirm()` could not have expressed,
and the reason `ConfirmDialog` takes an optional `secondaryAction`. The
description branches on the durability answer above: while the room is telling us
its writes are failing, the dialog stops claiming the board is keeping anything
and says a copy here may be the only one that survives. A copy that cannot be
written (storage full) keeps you in the room with an error, on the same reasoning
as starting a session — staying is recoverable, leaving with the copy silently
unwritten is not.

The prompt covers the menu, not every way out. The back button and the gallery
links still leave a room without asking: the App Router has no client-side
route-change guard to hang a question on, and "My boards" is where the board
itself lives, so asking there would interrupt the one exit that loses nothing.

**Two tabs merge instead of overwriting.** One key holds the whole scene, so the
last tab to autosave used to discard whatever the other had drawn — excalidraw.com
has the same behaviour. `storageSync` listens for the `storage` event (the
browser's only push channel between tabs, and one that never fires in the tab that
wrote, so no echo suppression is needed) and `reconcileScenes` merges the two.
Element `version` decides a conflict; for an element only one side has there are
no tombstones to consult, so the hook keeps the set of ids it has already
exchanged with the store — a missing id it knows was shared is a deletion, a
missing id it does not know is simply new. The merge takes the incoming array's
order and returns the local array unchanged by reference when nothing moved, which
is what stops two tabs answering each other forever. Adopting a merge does not
touch the undo stack: another tab's edit is not this tab's to undo.

**Preferences are not part of the scene.** The pen (colour, fill, width, opacity,
sloppiness, edge style) and the tool lock live in `collabdraw_preferences`, theme
in `collabdraw_theme` — separate keys, like Excalidraw's `excalidraw-state` beside
`excalidraw`. Being separate is what lets them survive a session in a room, where
scene saving is off. Each field is validated on its own when read, so a
hand-edited entry costs one setting rather than all of them, and they are
deliberately _not_ synced across tabs: a colour changing under you because you
picked a different one next door would be worse than two tabs disagreeing.

**What we deliberately did not copy.** Everything above is excalidraw.com's
model, close enough that the places it stops are worth naming rather than leaving
to be found. One is named already: the storage layout, a single versioned entry
holding elements and viewport together rather than their two unversioned keys.
The rest:

- **A second store for binary files.** Excalidraw keeps image bytes in IndexedDB,
  a data URL running to megabytes where `localStorage` holds a handful in total.
  There is nothing here to keep: `ElementType` is freehand, line, arrow, square,
  circle, diamond, triangle and text — no image element exists. The omission is
  right today and a constraint tomorrow, because pasting an image could not
  simply put the bytes in the scene: that is one `localStorage` entry and one
  `jsonb` column the write path refuses past 2MB (`MAX_SCENE_BYTES`), so images
  would need a store of their own for the same reason theirs do. The thumbnails
  table is that argument in miniature, split off so a fifty-board gallery does
  not drag data URLs through every list query.

- **The settings of features that are not here.** No shape library, no grid, no
  zen mode, so nothing of theirs to keep. What the pen keeps is bounded by what
  the style panel can change: `EditorPreferences` holds the whole `ElementStyle`
  (stroke, fill, fill style, stroke width and style, roughness, opacity, font
  size, font family, edge style) plus the tool lock, each field validated on its
  own on the way in.

- **A remembered file handle.** "Save to file" fills a blob and clicks an anchor
  at it, so saving twice leaves two dated files in Downloads; Excalidraw holds
  the handle of the file you opened and writes over it. The document is shaped
  like theirs deliberately (a `type` tag, a `version`, a `source`, then the
  elements) and is still not interchangeable: `parseSceneFile` rejects anything
  whose type tag is not `"collabdraw"`, and an `.excalidraw` file would not load
  even if it were accepted, elements here being `tool: "Square"` where theirs are
  `type: "rectangle"`.

- **Preferences between tabs.** The scene merges; the pen and the tool lock do
  not, for the reason in the paragraph above this list. It is the one place the
  two localStorage tiers are deliberately inconsistent with each other.

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
every stroke. The client writes the scene only when the socket is _disconnected_,
so the two writers do not race in practice; the server's next flush would correct
it anyway. Title and thumbnail are separate columns written only by the client, so
metadata never touches `scene`.

**The row may not be there.** The durable write was a bare UPDATE, on the grounds
that `/board/<id>` creates the row while rendering, before any socket can connect.
It does — except for a visitor who blocks cookies, there being no honest owner to
stamp, and except when Postgres was unreachable during that render and is up again
by the time a flush runs. The UPDATE then matched nothing, logged "scene kept in
Redis only", and left the room's whole drawing in a 24-hour cache. It is now an
upsert, which needs an owner for the row it creates: `"server"`, one of
`boardAccess.ts`'s `PLACEHOLDER_OWNER_IDS`, so the row arrives _unclaimed_ and the
first real device to write to it takes ownership — this write is the reason that
list exists. Turning an UPDATE into an INSERT also makes the id matter, room ids
being merely length-bounded where board ids are `^[A-Za-z0-9_-]{1,64}$`: a scene
whose room id could never be a board is skipped rather than stored under a key
`/board/<id>` would refuse to open.

**A deleted board is reported, not resurrected.** `do update` carries
`where boards.deleted_at is null`, so a board deleted from the gallery in another
tab stays deleted — and because the insert half now covers the missing-row case,
`rowCount === 0` means exactly one thing. That is what makes it worth saying out
loud instead of logging: `roomState` hands each write outcome to a reporter,
`index.js` emits it to the room as `scene-persistence`, and the canvas raises a
sticky toast naming the way out ("use Save to file to keep it"). Deleted, too large
for the column, and Postgres unreachable are the three a room hears; `skipped` is
not sent, a deployment with no `DATABASE_URL` having no store of record to lose
anything from. The server keeps no memory of what it last told a room — that would
be a map of every room the process has ever seen, with nobody to clean it — so it
reports after every attempt, and the client does the edge detection by keeping the
identity of its answer stable while the answer is unchanged.

**Shutting down is an ordering problem.** The scene lives in memory and is
written on a debounce, so an exit that does not wait for those writes loses up to
three seconds of everybody's drawing — and the writes it has to wait for are ones
nobody is holding. `state.js` fires the room-empty flush with `void`, and the
debounce fires from a timer callback, so asking which rooms are still dirty finds
nothing: each scene was handed to a write and forgotten in the same synchronous
step. `roomState` therefore keeps the set of writes in flight, and that is what
`flushAllRooms` drains. `server/src/shutdown.js` then runs one fixed sequence:
`io.close()` first, because disconnecting everyone is what _produces_ the last
flushes; the room scenes; the generation queue, Redis and the Postgres pool, in
that order, since a flush needs the stores it writes to; and only then the wait
for HTTP connections to end. Everything durable happens before anything that can
hang, so the deadline (`SHUTDOWN_TIMEOUT_MS`, 10s, meant to land inside a
platform's 30s grace period) can only ever cost bookkeeping; it logs which stage
it was stuck on. A second signal is ignored rather than forced, because forcing
discards exactly the writes the sequence exists for. `uncaughtException` and
`unhandledRejection` run the same sequence with a non-zero exit — that is the
case that used to lose everything, there having been no handler for it at all.

**Leaving is two different events.** Closing the tab fires `pagehide`, where the
document is about to stop existing and only a beacon still gets out. A
client-side route change — the "My boards" link, the back button — fires nothing
at all: React unmounts and the page lives on. `useBoardPersistence` handles both
in its cleanup, which is the fix for an offline board losing its last edits to a
route change, and for a quick edit-and-leave leaving the gallery tile stale. The
transport follows from which event it was: `sendBeacon` only for `pagehide`,
because it is the only one that can outlive the document and the only one with a
size ceiling (~64KB in Chromium, against the route's 2MB) — and it reports a
payload over that ceiling by _returning false_, so a refusal falls through to a
keepalive request. Everywhere the page survives the call (unmount, a merely
hidden tab) it is an ordinary request, which has no ceiling at all.

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
deliberately kept separate. Middleware sets a new id on the _request_ as well as
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
re-run hydration for a change of label. Because it is read once into that ref, a
second tab used to hold a stale copy and overwrite the rename on its own next
edit; the same `storage` listener the scene uses now re-reads the name, so a
rename in one tab reaches the other and the room roster with it. It is editable
in two places: the field at the top of the collaborator list, and a main-menu
item — the people button only exists in a room, and the name you want is the one
you set _before_ sharing.

Opening an unknown id creates the board (`insert ... on conflict do nothing`) so
old share links and collaborators' links never 404. The socket server's scene
flush creates one too, and it has no cookie to stamp: it writes the placeholder
owner `"server"`, which used to mean a board nobody could rename or delete and was
the reason that write stayed a bare `update`. Rows stamped that way are now
treated as unclaimed — `mayWriteBoardMetadata` lets any real device write to one,
and `claimBoard` takes ownership on the way through, guarded in SQL so a board
that already has an owner can never be stolen.

## Tests

`npm test` runs Vitest over the pure layers: geometry, the viewport transform,
element construction, hit testing, bindings, linear elements, the elbow router,
transforms, snapping, the AI intent/layout/build pipeline (including grid detection
and playing a turn on an existing board), and the renderer itself (via node-canvas,
including a determinism check that the same scene renders byte-identically twice).
On the socket server it covers every event and every route, because that is where
losing a write is silent: the durable write's own outcomes, `roomState`'s flush
bookkeeping and its Redis snapshot, the room, canvas and cursor handlers, the
generation queue and the worker that drains it, the HTTP routes over a real port,
and the shutdown sequence — the last mostly by asserting _order_. That is 99% of
the statements in `server/src`; the rest is `db.js`'s connection handling, which
needs a live Postgres to reach.

Two seams make that possible. Handlers take `(io, socket)` and reach the room
store and the flush scheduler through modules, so
`__tests__/helpers/handlerHarness.js` can hand them a recording socket, keep the
real store, fake the scheduler, and assert what came back out. And `index.js` and
`jobs/worker.js` do all their work at require time, in CommonJS that `vi.mock`
cannot reach, so `__tests__/helpers/moduleCache.js` plants fakes in
`require.cache` before the module loads — and evicts them afterwards, because a
Vitest worker process is shared between test files.

On the Next.js side the boundaries are covered the same way, and for the same
reason: `middleware.ts`, all six API routes, `app/lib/db.ts`, both paths of the
rate limiter, and the two provider transports in `app/services/ai/llm.ts`. What a
route does is mostly decide what to *send* — a SQL statement, or a request to a
paid provider — so the tests read that rather than the status code alone: the
board routes run against a fake `pg` driver, which puts the real query layer
under test in the same pass and pins the SQL each route emits, and the AI route
runs against a fake provider so the capped transcript, the capped scene and the
dropped image are visible in the call that would have left the process. The
transports are tested through a fake `GoogleGenAI` and a fake `fetch`, because
the schema translation and the SSE flattening have no other observable effect —
a mistake there sends a schema the model ignores and the only symptom is a
drawing that comes out wrong.

Two arrangements make that work. `app/lib/db.ts` decides whether a store is
configured when it is first imported, so a suite that wants "no `DATABASE_URL`"
has to say so in `vi.hoisted()`, before the imports run — hence one file per
configuration rather than one flag per test. And a Vitest worker is shared
between files, so each of those files deletes what it must not inherit
(`DATABASE_URL`, `REDIS_URL`, and the `globalThis` flags `db.ts` uses to cache
its pool and to log its one-time warning) instead of assuming a clean process.

The React side is covered the same way, and the environment had to be built
before any of it could be: the suite ran in `node` against a hand-rolled
`document` with a single method on it, and `vitest.config.ts` could not match a
`.tsx` file at all (#13). A file that needs a DOM now opts in for itself with
`// @vitest-environment jsdom`, so the pure layers keep node's start-up cost and
only the DOM tests pay for a DOM.

Each layer is tested at the seam below it, so the same behaviour is not asserted
twice. The hooks run under `renderHook` against a fake socket and a fake `fetch`,
which is where the persistence _cadence_ lives — the debounce interval, the pause
while a room is collaborative, the skipped write on a hidden tab, the flush on
unmount. None of that has any visible output, which is how #3 and #5 went
unnoticed. The presentational components take everything through props, so their
tests hand them props and read the DOM: `StylePanel` emits one key per control,
and a control that emitted a whole style instead is the bug that reset the other
nine properties on every colour pick.

`Canvas.tsx` cannot be tested that way, because being the join is what it is for.
Its tests fake only the two outward edges — `next/navigation` and the
collaboration context — plus `roughjs` and the renderer, and keep every real
hook, every real child and the real `localStorage`. `renderStaticScene` is then
the observable: its last call is the scene the editor settled on, in paint order,
which is z-order. A right-click that clears a multi-selection, a restyle that
reaches an unselected element, a peer's in-flight stroke painted twice — each is
an assertion about that array rather than a screenshot.

jsdom applies no media queries, so the desktop islands and the phone bars are all
mounted at once and their labels collide; queries there are scoped to a section or
a sheet, or indexed. That is the point rather than a nuisance, because the phone
bar carries its own copy of the desktop wiring — the drawer toggle, share,
zoom-to-fit, the properties sheet's own delete — and duplicated wiring is what
goes stale.

The five route files are covered last, and they are almost all degradation.
`/board/[id]` and `/boards` are Server Components that query Postgres, so each of
them has to leave a working canvas or an explicit notice behind when the database
is unreachable, and "no `DATABASE_URL` at all" gets a file of its own for the
reason above. The root layout is there for `THEME_SCRIPT`: a template literal
that nothing compiles, type-checks or lints, running before the first paint so a
dark board does not flash white. Its tests run the string. The whitelist inside it
is the load-bearing part — `useTheme` stores `"system"` as well, and
`data-theme="system"` matches no stylesheet.

What has no test: `scripts/*.mjs`, which the CI job below runs against a real
Postgres rather than a fake, and `app/types/collaboration.ts`, which is types only
and compiles to nothing. There is no end-to-end suite either — two clients
converging on one canvas is the app's central claim, and nothing verifies it the
way a user would.

`.github/workflows/ci.yml` is what makes any of that binding. Until it existed the
checks only ran when somebody remembered, so a regression surfaced whenever the
next person happened to look; now typecheck, tests, lint and build run on every
push to `main` and every pull request. The four steps carry `if: !cancelled()`
instead of stopping at the first red, because four verdicts from one push beats
discovering the next failure after each fix. Nothing needs a secret: every
variable the app reads has a fallback, so the build runs with none at all — which
also stops a missing key from quietly becoming a build-time dependency — and a
fork's pull request gets the same answer as a branch. A last step installs
`server/package-lock.json` from inside `server/`, the way that deploy does,
because nothing else exercises it: the tests under `server/src/__tests__` run off
the root install, which carries every server dependency, and the server's own
lockfile had drifted to the point of missing `pg` altogether.

A second job is the only place `migrations/001_boards.sql` has ever run from
scratch. Against a throwaway Postgres service container it applies the
migrations, runs the same `db:check` preflight a developer runs — the tables the
app queries are the tables the migrations create — and then applies them again,
asserting the runner reports "no pending migrations": the SQL is
`create table if not exists` throughout, so a re-application would otherwise pass
in silence whether or not the bookkeeping worked.

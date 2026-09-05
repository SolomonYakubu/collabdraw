# CollabDraw Realtime Server

Dedicated Socket.IO WebSocket backend for real-time multiplayer drawing, cursor synchronization, and canvas state persistence.

## Architecture

- `src/index.js` - HTTP server entry point, health checks (`/`, `/stats`), job endpoints, shutdown wiring.
- `src/config.js` - Port, CORS, store and shutdown configuration from environment variables.
- `src/shutdown.js` - The graceful shutdown sequence: room scenes are written before anything that can hang, under a deadline.
- `src/socket.js` - Socket.IO configuration and client connection dispatcher.
- `src/state.js` - In-memory store for active rooms, connected users, and canvas shape states.
- `src/roomState.js` - Debounced scene flushes to Redis and Postgres, and the set of writes in flight that shutdown drains.
- `src/db.js` - The durable scene write (an upsert that will not resurrect a deleted board) and the room's hydration read.
- `src/validation.js` - What counts as a room id, a board id, a tag and a shape, and the per-room limits.
- `src/handlers/` - Modular event listeners:
  - `roomHandler.js` - Room joins, active participant queries, peer canvas sync requests, disconnect cleanups.
  - `canvasHandler.js` - Drawing updates, shape additions, deletions, full canvas state syncs.
  - `cursorHandler.js` - High-frequency cursor positions, drawing drag previews, drawing state indicators.

## Environment Variables

| Variable               | Description                                                                  | Default                 |
| :--------------------- | :--------------------------------------------------------------------------- | :---------------------- |
| `PORT`                 | Server listening port                                                        | `3001`                  |
| `CLIENT_ORIGIN`        | Allowed CORS origin (e.g. `https://your-app.vercel.app`)                     | `http://localhost:3000` |
| `DATABASE_URL`         | Postgres (the store of record). Without it a room's scene lives only in Redis, and so only for 24 hours. | _unset_ |
| `REDIS_URL`            | Redis, used as a 24-hour hot cache and for the generation queue.              | _unset_                 |
| `REQUIRE_REDIS`        | `true` makes a missing `REDIS_URL` a startup error instead of degrading to in-memory state. | `false` |
| `STATS_TOKEN`          | Guards `/stats` in production; send it as `Authorization: Bearer <token>` or `x-stats-token`. | _unset_ |
| `SHUTDOWN_TIMEOUT_MS`  | How long shutdown waits before exiting anyway. Keep it under the platform's grace period (30s on Render and Heroku). | `10000`                 |

The background generation worker (`src/jobs/worker.js`, a separate process) also
reads `QUEUE_CONCURRENCY` (`2`), `QUEUE_MAX_PER_SEC` (`10`) and
`GENERATION_PROCESSOR_MODULE` (its own default processor).

## Running Locally

From repository root:

```bash
npm run server
```

Or from inside `server/`:

```bash
npm install
npm start
```

## Deployment (Render / Railway / Fly.io)

When deploying this server independently:

- **Root Directory:** `server` (or repository root with start command `node server/src/index.js`)
- **Build Command:** `npm install`
- **Start Command:** `npm start` (or `node src/index.js`)
- Set `CLIENT_ORIGIN` to your Vercel deployment URL.

# CollabDraw Realtime Server

Dedicated Socket.IO WebSocket backend for real-time multiplayer drawing, cursor synchronization, and canvas state persistence.

## Architecture

- `src/index.js` - HTTP server entry point, health checks (`/`, `/stats`), process signal handlers.
- `src/config.js` - Port and CORS configuration from environment variables.
- `src/socket.js` - Socket.IO configuration and client connection dispatcher.
- `src/state.js` - In-memory store for active rooms, connected users, and canvas shape states.
- `src/handlers/` - Modular event listeners:
  - `roomHandler.js` - Room joins, active participant queries, peer canvas sync requests, disconnect cleanups.
  - `canvasHandler.js` - Drawing updates, shape additions, deletions, full canvas state syncs.
  - `cursorHandler.js` - High-frequency cursor positions, drawing drag previews, drawing state indicators.

## Environment Variables

| Variable        | Description                                              | Default |
| :-------------- | :------------------------------------------------------- | :------ |
| `PORT`          | Server listening port                                    | `3001`  |
| `CLIENT_ORIGIN` | Allowed CORS origin (e.g. `https://your-app.vercel.app`) | `*`     |

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

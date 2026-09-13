# Flutter handoff — Live ghosts + heartbeat (easy)

Share this with the Flutter developer. **Backend team will stage Live-server changes separately.**  
No production push until staging OK.

## Problem in one line

Go-live API can mark the user **live** before LiveKit works. If Wi‑Fi fails or the app exits badly, the room stays live for others while the host never (or no longer) streams.

## What already works in the app

On **LiveRoomScreen** (host only):

- Every **3 seconds**: socket event `stream_heartbeat` with `{ streamId }`
- If socket is down: `POST /api/live-stream/heartbeat` with `{ streamId }`
- Leave button calls **endStream**
- Minimize should **keep** the live (do not end)

Heartbeat does **not** run on the Go Live preview screen.

## What you must change

### 1. Failed go-live must cancel the room (most important)

In `go_live_screen.dart`, after a successful go-live API, if `LiveKit connect` fails:

- Call **endStream** with the new stream id  
- Disconnect LiveKit if needed  
- Then show the error snackbar  

Today the catch only shows the snackbar → **ghost live**.

### 2. Leaving the app / disposing the room

- Explicit **End / Leave** already ends the stream — keep that  
- If the host leaves the live UI without End (dispose / kill), prefer calling **endStream** when it is safe  
- **Exception:** user **minimized** the live — do **not** end  

### 3. Keep heartbeat as-is (small polish OK)

- Keep 3s socket + REST fallback  
- Start heartbeat only after the host is really on LiveRoomScreen  

## Staging tests before release

1. Normal go-live — works; heartbeat logs every 3s  
2. Fail LiveKit after API (bad network / airplane) — error shown; stream **not** left live  
3. End live — viewers kicked / stream ended  
4. Force-kill app while live — stream ends within about a minute  
5. Minimize — stays live  

## Backend will also

- Stronger sweeper (no LiveKit host publisher → end stream)  
- Cleanup existing ghosts on staging/prod after confirm  
- Rely on existing ~15s heartbeat timeout + ~30s host disconnect timeout  

Full detail: [phase2-ghost-live-and-flutter-heartbeat.md](./phase2-ghost-live-and-flutter-heartbeat.md)

## Backend shipped (staging)

Live-server now (staging `ol-live` restarted; log shows `livekitGrace: 90000ms, ghostSweep: true`):

1. **`endLiveStream`** — works with DB id or `streamId`; Redis-only abort if DB row not inserted yet; clears Redis markers aggressively.
2. **Ghost sweeper** — if a stream is `is_live` for **>90s** and the host identity is **not** in the LiveKit room → auto-end (`NO_LIVEKIT_HOST`). Env: `LIVE_GHOST_LIVEKIT_GRACE_MS`, `LIVE_GHOST_SWEEP_ENABLED`.
3. **Heartbeat monitor re-enabled** on staging sockets (was commented `// Heartbeat disabled`) — ~15s heartbeat loss + ~30s host disconnect.
4. Nothing pushed to remotes / prod yet.

Flutter must still call `endStream` on failed LiveKit connect for instant UX (see checklist above).

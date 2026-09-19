# Phase 2 — Ghost live streams + Flutter heartbeat handoff

**Status:** Committed on **master** / **staging**. Heartbeat + LiveKit ghost sweep enabled. **Not on production** until sign-off.  
**ol_app:** Flutter work still required — see `flutter-live-ghost-heartbeat-handoff.md`.

**Update (2026-09-14):** `LIVE_GHOST_LIVEKIT_GRACE_MS` default lowered from 90000ms to **20000ms** (`src/routes/service/serviceHeartbeat.js`). The 90s figure throughout this doc is historical — the sweeper now auto-ends a ghost (no LiveKit host) after ~20s instead of ~90s. Backend-only mitigation; the ol_app rollback fix described below is still not implemented.

**Update (2026-09-19):** Ghost sweep now distinguishes a **true ghost** (host never confirmed present in LiveKit for this stream — still ends fast, ~20s) from a **drop after the host was confirmed live** (host connected at least once, then LiveKit presence disappears — e.g. app backgrounded, brief network loss). The former still uses `LIVE_GHOST_LIVEKIT_GRACE_MS` (20s); the latter no longer ends the stream directly — it defers to the heartbeat-lost check, which now has a **90s** grace (`LIVE_HEARTBEAT_TIMEOUT_MS` default raised 15000ms → 90000ms) so a user who briefly switches apps doesn't get their stream killed. New Redis marker: `stream:host_confirmed:{streamId}` (set once LiveKit presence is seen, 24h safety TTL, cleaned up in `clearLiveStreamRedisKeys`). Also fixed: `stream:heartbeat:{streamId}`'s own Redis TTL was hardcoded to 30s — shorter than the new 90s timeout, which would have made the monitor fall back to stream-age and end the stream ~30s after the last ping regardless of the raised timeout. TTL is now derived from `LIVE_HEARTBEAT_TIMEOUT_MS` (+15s buffer). The socket host-disconnect timer (previously hardcoded 30s in `socket-live-service.js`) is now `HOST_DISCONNECT_TIMEOUT_MS`, defaulting to the same value as `LIVE_HEARTBEAT_TIMEOUT_MS` (new env override: `LIVE_HOST_DISCONNECT_TIMEOUT_MS`) so it can't end the stream before the heartbeat grace has a chance to. None of this required any ol_app changes — it only reinterprets signals the client already sends (3s heartbeat ping, existing socket connect/disconnect, existing LiveKit presence).

Video-call protection is unchanged and still applies uniformly: `hostPausedForCallOrReturn()` (ACTIVE video call, or 2-minute post-call return grace) is checked before *any* auto-end path (ghost sweep, heartbeat-lost, socket-disconnect-timeout) ends a stream, so a host mid-call is never dropped by the ghost sweeper regardless of call length.

---

## What Phase 2 was (original) + what we are expanding to

### Original Phase 2 (`2C`)

1. Flutter: on LiveKit connect failure after go-live API, call `endStream` (rollback).
2. Live-server: harden abort / end when Redis+DB already marked live.
3. One-time cleanup of existing ghost `is_live` rows.
4. Server sweeper: end lives with no LiveKit participant / stale heartbeat.

### Expanded goals (this doc)

| Scenario | What users see | Backend today | Fix |
|---|---|---|---|
| **A. Wi‑Fi / LiveKit fail after go-live** | Snackbar “Failed to go live”; host never enters live UI | `POST /go-live` already set `is_live=true` + Redis; **no** `endStream` in catch | Flutter rollback + server LiveKit check |
| **B. Ghost room others can join** | Viewers join “live” host who never published | Same as A — listed as live without host media | Same as A + don’t list / end if no host publisher |
| **C. Host kills / leaves app without End** | Stream stays live; viewers stuck | Heartbeat should end ~15s; socket host disconnect ~30s — **gaps** if heartbeat never started or dispose skips `endStream` | Flutter: end on leave/kill paths; server sweeper backup |
| **D. Minimize live (PIP)** | Intentional keep-alive | Heartbeat continues | **Do not** end on minimize |

---

## Root cause (simple)

```text
POST /go-live  →  Redis + DB is_live=true  →  return token
        ↓
App Room.connect(LiveKit)
        ↓
   success → LiveRoomScreen → heartbeat every 3s
   fail    → snackbar only → stream STILL live (ghost)
```

Heartbeat monitor only helps **after** ~15s and only if it is running. It does **not** replace an immediate rollback when connect fails.  
`LiveRoomScreen.dispose()` **stops** heartbeat but does **not** call `endStream` — only `_onLeaveRoom` does. Force-kill relies on server timers.

---

## Current heartbeat (ol_app — already integrated)

### Where

| File | Role |
|---|---|
| `lib/features/home/live_room_screen.dart` | Host-only: `_startHeartbeat` / `_stopHeartbeat` / `_sendHeartbeatPing` |
| `lib/core/config/api_service/api_service.dart` | `sendStreamHeartbeat(streamId:)` → `POST …/api/live-stream/heartbeat` |

### Behaviour today

- Starts only when host is on **`LiveRoomScreen`** (`widget.isHost == true`).
- Interval: **every 3 seconds**.
- Preferred: socket `emit('stream_heartbeat', { streamId })`.
- Fallback if socket down: REST `POST {liveBaseUrl}/api/live-stream/heartbeat` body `{ streamId }` (also tries `/live-stream/heartbeat` on 404).
- Stopped on: leave room, stream ended, dispose, some reconnect paths.
- **Not** started on `GoLiveScreen` (preview).

### Live-server side (already)

| Piece | Behaviour |
|---|---|
| Socket `stream_heartbeat` | Writes Redis `stream:heartbeat:{streamId}` TTL **30s** |
| REST heartbeat | Same |
| Monitor (`serviceHeartbeat.js`) | Every **5s**; if no ping for **>15s** (after 15s start grace) → `endLiveStreamService` + `stream_ended` reason `HEARTBEAT_LOST` (skips if video-call / 2‑min return grace) |
| Socket host `disconnect` | **30s** timer → auto-end `HOST_DISCONNECTED_TIMEOUT` (same pause conditions) |

Recent ol_app work already added this host heartbeat into `live_room_screen.dart` (socket + REST fallback + `HEARTBEAT_LOST` UI copy).

---

## Flutter developer — required changes (checklist)

Do **not** change minimize behaviour. Keep existing heartbeat as primary keep-alive once truly live.

### 1) Rollback after failed LiveKit connect (critical — Scenario A/B)

**File:** `lib/features/livePhoto/go_live_screen.dart` (go-live try/catch)

After `goLive()` succeeds you have a session + token. If `livekitService.connect(...)` (or anything after) throws:

1. Best-effort call existing `liveStreamProvider.notifier.endStream(session.id)` (same API as leave).
2. Best-effort `liveKitService.disconnect()` if partially connected.
3. Then show “Failed to go live” snackbar as today.

Pseudo:

```dart
LiveStreamSession? createdSession;
try {
  final token = await goLive(...);
  createdSession = ref.read(liveStreamProvider).currentSession;
  await livekitService.connect(...);
  // navigate to LiveRoomScreen...
} catch (e) {
  final id = createdSession?.id ?? ref.read(liveStreamProvider).currentSession?.id;
  if (id != null) {
    try { await ref.read(liveStreamProvider).notifier.endStream(id); } catch (_) {}
  }
  try { await ref.read(liveKitServiceProvider).disconnect(); } catch (_) {}
  // existing snackbar / pop loading
}
```

### 2) Host leave / kill paths must end stream (Scenario C)

| Path | Today | Needed |
|---|---|---|
| Explicit leave (`_onLeaveRoom`) | Calls `endStream` | Keep |
| `dispose()` (back, kill, replace route) | `_stopHeartbeat` only | If still host of active stream and **not** minimizing → call `endStream` (or ensure server will end; prefer client `endStream` when possible) |
| App lifecycle `detached` / `paused` long | Unclear | Optional: on `AppLifecycleState.detached` (and maybe long paused) host calls `endStream` if not minimized |
| Minimize / PIP | Must stay live | If you add dispose endStream, **skip** when entering minimize |

Coordinate with `minimizedLiveRoomProvider` so minimize does not look like leave.

### 3) Heartbeat — small hardenings (optional but recommended)

- Keep 3s socket + REST fallback (already good).
- Ensure `_startHeartbeat()` runs as soon as host `LiveRoomScreen` is shown (already).
- On `stream_ended` with `HEARTBEAT_LOST` / `HOST_DISCONNECTED_TIMEOUT`, leave room cleanly (already partially handled).
- Do **not** start heartbeat on GoLive preview screen.

### 4) Staging test matrix (Flutter)

Use **staging** `liveBaseUrl` + staging LiveKit if available; otherwise document which SFU staging uses.

| # | Test | Expect |
|---|---|---|
| 1 | Go live on good network | Live + heartbeat logs every 3s |
| 2 | Airplane mode mid LiveKit connect after API success | Failed snackbar; stream **not** listed live within ~few seconds; `endStream` called |
| 3 | Go live, leave via End | Immediate end; viewers get `stream_ended` |
| 4 | Go live, force-kill app | Within ~15–45s stream ends (heartbeat and/or disconnect timer) |
| 5 | Minimize live | Stays live; heartbeat continues |
| 6 | Bad Wi‑Fi (if reproducible) | No ghost listing; or ends quickly after fail |

---

## Live-server / backend — staging then prod (engineering)

Implement on **Live-server** (and ops cleanup), not ol-node go-live path.

1. **Immediate abort API** (optional if Flutter always has `endStream` id):  
   `POST /api/live-stream/:id/end` must work even if only Redis was written and DB async insert lagged.

2. **Sweeper enhancement** (in addition to heartbeat):  
   For `is_live=true` older than N minutes (e.g. 2–5), if LiveKit room has **no** participant with host identity / no publisher → `endLiveStreamService`.  
   This catches Wi‑Fi ghosts where heartbeat never started and any monitor gap.

3. **Staging verify** heartbeat monitor is started (`startStreamHeartbeatMonitor` on socket init — already in `socket-live-service.js`).

4. **One-time cleanup** on staging/prod after deploy: end known ghosts (`is_live` + no LiveKit host).

5. Docs: flow-md + context when shipping (per repo rules).

---

## Backend implementation status (2026-09-12)

Deployed to **staging** (`ol-stag` / `ol-live`). **Not pushed to git remotes / not prod.**

| Change | File |
|---|---|
| Redis-safe end + Redis-only abort | `src/routes/service/serviceLive.js` |
| LiveKit presence helper | `src/routes/service/livekitPresence.js` |
| Ghost sweeper `NO_LIVEKIT_HOST` after 90s + heartbeat | `src/routes/service/serviceHeartbeat.js` |
| Re-enabled `stream_heartbeat` + monitor on staging sockets | staging `socket-live-service.js` (was commented `// Heartbeat disabled`) |

Staging log confirms:
`[Heartbeat Protection] Background monitor started (... livekitGrace: 90000ms, ghostSweep: true).`

Env (optional):

```bash
LIVE_GHOST_SWEEP_ENABLED=true
LIVE_GHOST_LIVEKIT_GRACE_MS=90000
LIVE_HEARTBEAT_TIMEOUT_MS=15000
LIVE_HEARTBEAT_START_GRACE_MS=15000
```

Flutter still required for instant rollback on connect fail — see handoff doc.

### Staging test tips

1. Create a ghost: call go-live API then never connect LiveKit — within ~90s should auto-end (`NO_LIVEKIT_HOST`).
2. Normal live with host heartbeat — should stay up.
3. Kill app mid-live — heartbeat loss ends within ~15–45s.
4. Flutter `endStream` on connect fail — immediate (once app ships).


---

## Quick architecture (for Flutter share)

```text
[GoLiveScreen]
  POST /go-live → token + is_live=true
  Room.connect(wss://stream…)
       ├─ OK → LiveRoomScreen → stream_heartbeat @ 3s
       └─ FAIL → MUST endStream(id)   ← Phase 2 Flutter #1

[LiveRoomScreen host]
  heartbeat → socket/REST → Redis TTL 30s
  leave → endStream
  kill/dispose without end → server heartbeat ~15s / disconnect ~30s

[Live-server]
  heartbeat monitor + disconnect timer + (new) LiveKit empty-room sweeper
```

---

## Contact points in code

**Flutter**

- Go-live: `lib/features/livePhoto/go_live_screen.dart`
- Heartbeat / leave: `lib/features/home/live_room_screen.dart`
- REST heartbeat: `ApiService.sendStreamHeartbeat`
- End API: `liveStreamProvider.notifier.endStream`

**Live-server**

- Go-live create: `src/routes/service/serviceLive.js` → `fastGoLiveStreamService`
- End: `endLiveStreamService`
- Heartbeat: `src/routes/service/serviceHeartbeat.js`
- Socket: `src/routes/service/socket-live-service.js` (`stream_heartbeat`, host disconnect timer)

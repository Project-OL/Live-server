#!/usr/bin/env node
/**
 * INF-18: socket fan-out load test, STAGING ONLY.
 *
 *   node scripts/load/socket-fanout.mjs [viewers=200] [seconds=60] [msgPerSec=2] [out.json]
 *
 * The QA host goes live; N viewer sockets connect and join the room; the host posts chat over REST
 * at msgPerSec for `seconds`. Each message carries its send time, so every viewer measures send →
 * receive latency for `new_message`. Reports connect time, fan-out latency percentiles, delivery
 * ratio (received / expected), server /live-health event-loop lag before/after, then ends the stream.
 * Viewers reuse one QA login (staging socket auth is in log mode), so this measures the server's
 * socket/Redis-adapter path, not auth. Same env names as scripts/contract/*.mjs.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { io } = require("socket.io-client");

const LIVE = process.env.CONTRACT_LIVE_BASE || "https://live-staging.offoolive.com";
const API = process.env.CONTRACT_API_BASE || "https://api-staging.offoolive.com/api/v1";
const PASSWORD = process.env.CONTRACT_PASSWORD || "ValidPass1!";
const HOST_ID = process.env.CONTRACT_HOST_ID || "34216594";
const VIEWER_ID = process.env.CONTRACT_VIEWER_ID || "34216589";
const [VIEWERS = "200", SECONDS = "60", RATE = "2", OUT] = process.argv.slice(2);
const N = Number(VIEWERS), DUR = Number(SECONDS), MPS = Number(RATE);

if ([LIVE, API].some((u) => ["live.offoolive.com", "api.offoolive.com", "offoolive.com"].includes(new URL(u).hostname))) {
    console.error("Refusing to load-test production.");
    process.exit(2);
}

const TOKEN_CACHE = path.join(os.tmpdir(), "live-server-contract-tokens.json");
const jwtPayload = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
const login = async (publicId) => {
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(TOKEN_CACHE, "utf8")); } catch {}
    const key = `${API}|${publicId}`;
    if (cache[key] && jwtPayload(cache[key]).exp * 1000 > Date.now() + 10 * 60 * 1000) return cache[key];
    const r = await fetch(`${API}/auth/login/password`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "publicId", identifier: publicId, password: PASSWORD, deviceName: "live-load", deviceId: `live-load-${publicId}` })
    });
    const j = await r.json();
    const token = j?.data?.accessToken ?? j?.accessToken;
    if (!token) throw new Error(`login failed for ${publicId}: HTTP ${r.status}`);
    try { fs.writeFileSync(TOKEN_CACHE, JSON.stringify({ ...cache, [key]: token }), { mode: 0o600 }); } catch {}
    return token;
};
const api = (token, method, p, body) =>
    fetch(`${LIVE}/api${p}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) })
        .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
const health = () => fetch(`${LIVE}/live-health`).then((r) => r.json()).catch(() => null);
const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : null);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const hostTok = await login(HOST_ID);
const viewerTok = await login(VIEWER_ID);
const viewerUid = jwtPayload(viewerTok).userId;
const before = await health();

const live = await api(hostTok, "POST", "/live-stream/go-live", { title: "load test", heading: "qa" });
const dbId = live.json?.data?.id, streamId = live.json?.data?.streamId;
if (!dbId) throw new Error(`go-live failed: HTTP ${live.status}`);
const hostSock = io(LIVE, { transports: ["websocket"], auth: { token: hostTok }, reconnection: false });
await new Promise((r) => hostSock.once("connect", r));
hostSock.emit("join_stream", { streamId });
hostSock.emit("toggle_camera_state", { streamId, isCameraOn: true });

const latencies = [];
const connectMs = [];
let received = 0, connectErrors = 0, disconnects = 0;
const sockets = [];
const RUN = `lt-${Date.now()}`;
try {
    // Connect viewers in waves of 25 (a real audience doesn't arrive in one millisecond).
    for (let i = 0; i < N; i += 25) {
        const wave = [];
        for (let j = i; j < Math.min(N, i + 25); j++) {
            wave.push(new Promise((resolve) => {
                const t0 = Date.now();
                const s = io(LIVE, { transports: ["websocket"], auth: { token: viewerTok, userId: viewerUid }, reconnection: false, timeout: 20000, forceNew: true });
                s.on("new_message", (m) => {
                    const text = String(m?.message ?? m?.text ?? "");
                    const hit = text.match(new RegExp(`${RUN}:(\\d+)`));
                    if (hit) { received++; latencies.push(Date.now() - Number(hit[1])); }
                });
                s.on("disconnect", () => disconnects++);
                s.once("connect", () => { connectMs.push(Date.now() - t0); s.emit("join_stream", { streamId }); sockets.push(s); resolve(); });
                s.once("connect_error", () => { connectErrors++; resolve(); });
            }));
        }
        await Promise.all(wave);
    }
    await wait(2000);
    const connected = sockets.length;
    console.log(`connected ${connected}/${N} viewers (errors ${connectErrors}); sending ${MPS}/s for ${DUR}s`);

    let sent = 0, sendErrors = 0;
    const iv = setInterval(async () => {
        const r = await api(hostTok, "POST", `/live-stream/${dbId}/message`, { message: `${RUN}:${Date.now()}` });
        if (r.status === 200 || r.status === 201) sent++; else sendErrors++;
    }, 1000 / MPS);
    await wait(DUR * 1000);
    clearInterval(iv);
    await wait(3000);

    const mid = await health();
    latencies.sort((a, b) => a - b);
    connectMs.sort((a, b) => a - b);
    const expected = sent * connected;
    const result = {
        at: new Date().toISOString(), against: LIVE, viewers: N, connected, connectErrors, seconds: DUR, msgPerSec: MPS,
        sent, sendErrors, expected, received, deliveryPct: expected ? Math.round((received / expected) * 10000) / 100 : null,
        connectMs: { p50: pct(connectMs, 50), p95: pct(connectMs, 95), max: connectMs.at(-1) },
        fanoutMs: { p50: pct(latencies, 50), p95: pct(latencies, 95), p99: pct(latencies, 99), max: latencies.at(-1) },
        disconnectsDuringRun: disconnects,
        serverLoopLagP99Ms: { before: before?.eventLoopLagP99Ms, after: mid?.eventLoopLagP99Ms }
    };
    console.log(JSON.stringify(result, null, 1));
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
} finally {
    for (const s of sockets) s.close();
    await api(hostTok, "POST", `/live-stream/end/${dbId}`, {});
    hostSock.close();
    setTimeout(() => process.exit(0), 500);
}

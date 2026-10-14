#!/usr/bin/env node
/**
 * LIVE-52: Live-server API contract snapshots (what ol_app reads must not break).
 *
 *   node scripts/contract/run.mjs record   # write contracts/live-server.contract.json
 *   node scripts/contract/run.mjs check    # replay and fail on breaking changes
 *
 * Drives real flows against STAGING with the QA accounts (never production) and records the
 * shape (keys + types, never values) of every REST response and socket event. `check` fails when a
 * required key disappears, a type changes or a status code changes; new keys pass (additive-only,
 * like ol-node-rest's API_CONTRACT_LOCK).
 *
 * Env: CONTRACT_LIVE_BASE (default https://live-staging.offoolive.com),
 *      CONTRACT_API_BASE  (default https://api-staging.offoolive.com/api/v1),
 *      CONTRACT_HOST_ID / CONTRACT_VIEWER_ID / CONTRACT_PASSWORD (staging QA public ids).
 * Money flows (gifts, call billing) are deliberately not here: they are covered by DB-level
 * concurrency tests, not by spending coins on staging.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { shapeOf, mergeShapes, compareShapes } from "./shape.mjs";

const require = createRequire(import.meta.url);
const { io } = require("socket.io-client");

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_FILE = path.resolve(here, "../../contracts/live-server.contract.json");
const LIVE = process.env.CONTRACT_LIVE_BASE || "https://live-staging.offoolive.com";
const API = process.env.CONTRACT_API_BASE || "https://api-staging.offoolive.com/api/v1";
const PASSWORD = process.env.CONTRACT_PASSWORD || "ValidPass1!";
const HOST_ID = process.env.CONTRACT_HOST_ID || "34216594";
const VIEWER_ID = process.env.CONTRACT_VIEWER_ID || "34216589";

const PROD_HOSTS = new Set(["live.offoolive.com", "api.offoolive.com", "offoolive.com"]);
if ([LIVE, API].some((u) => PROD_HOSTS.has(new URL(u).hostname))) {
    console.error("Refusing to run contract flows against production.");
    process.exit(2);
}

const mode = process.argv[2];
if (!["record", "check"].includes(mode)) {
    console.error("usage: run.mjs record|check");
    process.exit(2);
}

const observed = {}; // name -> { status?, shape }
const note = (name, status, body) => {
    const shape = shapeOf(body);
    const prev = observed[name];
    observed[name] = { status, shape: prev ? mergeShapes(prev.shape, shape) : shape };
};

/** fetch with retries on network errors only (an HTTP status is part of the contract, never retried). */
const fetchRetry = async (url, init, attempts = 3) => {
    for (let i = 1; ; i++) {
        try {
            return await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
        } catch (err) {
            if (i >= attempts) throw err;
            await new Promise((r) => setTimeout(r, 500 * i));
        }
    }
};

const http = async (name, method, url, { token, body } = {}) => {
    const res = await fetchRetry(url, {
        method,
        headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try {
        json = await res.json();
    } catch {}
    if (name) note(name, res.status, json);
    return { status: res.status, json };
};

// Tokens are cached outside the repo between runs (the auth endpoints are rate limited per IP).
const TOKEN_CACHE = path.join(os.tmpdir(), "live-server-contract-tokens.json");
const readTokenCache = () => {
    try {
        return JSON.parse(fs.readFileSync(TOKEN_CACHE, "utf8"));
    } catch {
        return {};
    }
};
const jwtPayload = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());

const login = async (publicId) => {
    const key = `${API}|${publicId}`;
    const cached = readTokenCache()[key];
    if (cached && jwtPayload(cached).exp * 1000 > Date.now() + 5 * 60 * 1000) {
        return { token: cached, userId: jwtPayload(cached).userId };
    }
    const r = await http(null, "POST", `${API}/auth/login/password`, {
        body: {
            provider: "publicId",
            identifier: publicId,
            password: PASSWORD,
            deviceName: "live-contract",
            deviceId: `live-contract-${publicId}`,
        },
    });
    const token = r.json?.data?.accessToken ?? r.json?.accessToken;
    if (!token) throw new Error(`login failed for ${publicId}: HTTP ${r.status}${r.status === 429 ? " (auth rate limit; wait a minute)" : ""}`);
    try {
        fs.writeFileSync(TOKEN_CACHE, JSON.stringify({ ...readTokenCache(), [key]: token }), { mode: 0o600 });
    } catch {}
    return { token, userId: jwtPayload(token).userId };
};

const connect = (who, { token, userId }) =>
    new Promise((resolve, reject) => {
        const s = io(LIVE, { transports: ["websocket"], auth: { token, userId }, query: { userId }, reconnection: false });
        s.onAny((event, payload) => note(`socket:${who}:${event}`, undefined, payload ?? null));
        s.once("connect", () => resolve(s));
        s.once("connect_error", reject);
    });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const run = async () => {
    const host = await login(HOST_ID);
    const viewer = await login(VIEWER_ID);
    const H = { token: host.token };
    const V = { token: viewer.token };

    // --- read-only REST ---------------------------------------------------------------
    await http("GET /live-stream/list", "GET", `${LIVE}/api/live-stream/list?page=1&limit=20`, V);
    await http("GET /live-stream/gifts", "GET", `${LIVE}/api/live-stream/gifts`, V);
    await http("GET /live-stream/wallet/balance", "GET", `${LIVE}/api/live-stream/wallet/balance`, V);
    await http("GET /live-stream/user/effect-settings", "GET", `${LIVE}/api/live-stream/user/effect-settings`, V);
    await http("GET /live-stream/host-stats", "GET", `${LIVE}/api/live-stream/host-stats?period=today`, H);
    await http("GET /live-stream/fans-ranking/:hostId", "GET", `${LIVE}/api/live-stream/fans-ranking/${host.userId}?period=today`, V);
    await http("GET /live-stream/follow-check/:id", "GET", `${LIVE}/api/live-stream/follow-check/${host.userId}`, V);
    await http("GET /live-stream/gift-gallery/targets", "GET", `${LIVE}/api/live-stream/gift-gallery/targets`, H);
    await http("GET /live-stream/my-photo", "GET", `${LIVE}/api/live-stream/my-photo`, H);
    await http("GET /users/me/restrictions", "GET", `${LIVE}/api/users/me/restrictions`, V);
    await http("GET /video-call/gifts", "GET", `${LIVE}/api/video-call/gifts`, V);
    await http("GET /video-call/settings/:creatorId", "GET", `${LIVE}/api/video-call/settings/${host.userId}`, V);
    await http("GET /live-stream/list (no auth)", "GET", `${LIVE}/api/live-stream/list`, {});

    // --- live room flow ------------------------------------------------------------------
    const hs = await connect("host", host);
    const vs = await connect("viewer", viewer);
    const live = await http("POST /live-stream/go-live", "POST", `${LIVE}/api/live-stream/go-live`, {
        ...H,
        body: { title: "contract check", heading: "qa" },
    });
    const streamId = live.json?.data?.streamId ?? live.json?.data?.stream?.streamId;
    if (!streamId) throw new Error(`go-live failed: HTTP ${live.status}`);
    try {
        hs.emit("join_stream", { streamId });
        hs.emit("toggle_camera_state", { streamId, isCameraOn: true });
        hs.emit("stream_heartbeat", { streamId });
        await http("POST /live-stream/heartbeat", "POST", `${LIVE}/api/live-stream/heartbeat`, { ...H, body: { streamId } });
        await http("GET /live-stream/:id", "GET", `${LIVE}/api/live-stream/${streamId}`, V);
        await http("POST /live-stream/join/:id", "POST", `${LIVE}/api/live-stream/join/${streamId}`, { ...V, body: {} });
        vs.emit("join_stream", { streamId });
        await wait(1500);
        await http("POST /live-stream/:id/message", "POST", `${LIVE}/api/live-stream/${streamId}/message`, {
            ...V,
            body: { message: "contract check message" },
        });
        await http("GET /live-stream/:id/messages", "GET", `${LIVE}/api/live-stream/${streamId}/messages`, V);
        vs.emit("request_to_join_sheet", { streamId });
        await wait(1000);
        hs.emit("accept_sheet_request", { streamId, targetUserId: viewer.userId });
        await wait(1000);
        vs.emit("toggle_self_mute", { streamId, muteState: true });
        // Socket handlers run concurrently; leaving the seat too soon races the mute (no event).
        await wait(1000);
        vs.emit("leave_sheet", { streamId });
        hs.emit("clear_chat", { streamId });
        await wait(1500);
        await http("POST /live-stream/leave/:id", "POST", `${LIVE}/api/live-stream/leave/${streamId}`, { ...V, body: {} });
        vs.emit("leave_stream", { streamId });
        await wait(500);
    } finally {
        await http("POST /live-stream/end/:id", "POST", `${LIVE}/api/live-stream/end/${streamId}`, { ...H, body: {} });
    }

    // --- video call: initiate -> reject, initiate -> caller ends (missed). No billing. --------
    const call1 = await http("POST /video-call/initiate", "POST", `${LIVE}/api/video-call/initiate`, {
        ...V,
        body: { creatorId: host.userId },
    });
    const s1 = call1.json?.data?.id;
    if (s1) {
        await wait(1000);
        await http("GET /video-call/status/:id", "GET", `${LIVE}/api/video-call/status/${s1}`, V);
        await http("POST /video-call/heartbeat", "POST", `${LIVE}/api/video-call/heartbeat`, { ...V, body: { sessionId: s1 } });
        await http("POST /video-call/reject", "POST", `${LIVE}/api/video-call/reject`, { ...H, body: { sessionId: s1 } });
        await wait(1000);
        const call2 = await http("POST /video-call/initiate", "POST", `${LIVE}/api/video-call/initiate`, {
            ...V,
            body: { creatorId: host.userId },
        });
        const s2 = call2.json?.data?.id;
        if (s2) {
            await wait(1000);
            await http("POST /video-call/end", "POST", `${LIVE}/api/video-call/end`, { ...V, body: { sessionId: s2 } });
        }
        await wait(1500);
    }
    hs.close();
    vs.close();
};

let flowError = null;
await run().catch((e) => {
    flowError = e;
    console.error("flow error:", e.message);
    process.exitCode = 1;
});
if (flowError && Object.keys(observed).length === 0) {
    console.error("Flow aborted before any request was observed; nothing to record or compare.");
    process.exit(1);
}

if (mode === "record") {
    fs.mkdirSync(path.dirname(CONTRACT_FILE), { recursive: true });
    const sorted = Object.fromEntries(Object.entries(observed).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(
        CONTRACT_FILE,
        JSON.stringify({ recordedAt: new Date().toISOString(), against: LIVE, contracts: sorted }, null, 2) + "\n"
    );
    console.log(`recorded ${Object.keys(sorted).length} contracts -> ${path.relative(process.cwd(), CONTRACT_FILE)}`);
} else {
    const recorded = JSON.parse(fs.readFileSync(CONTRACT_FILE, "utf8")).contracts;
    const problems = [];
    for (const [name, rec] of Object.entries(recorded)) {
        const now = observed[name];
        if (!now) {
            problems.push(`${name}: not observed (flow did not reach it, or the event is no longer sent)`);
            continue;
        }
        if (rec.status !== undefined && rec.status !== now.status) {
            problems.push(`${name}: status ${rec.status} -> ${now.status}`);
        }
        for (const p of compareShapes(rec.shape, now.shape)) problems.push(`${name}: ${p}`);
    }
    const added = Object.keys(observed).filter((n) => !recorded[n]);
    if (added.length) console.log(`new (allowed, not yet recorded): ${added.join(", ")}`);
    if (problems.length) {
        console.error(`CONTRACT CHECK FAILED (${problems.length}):\n  ` + problems.join("\n  "));
        process.exitCode = 1;
    } else {
        console.log(`contract check passed: ${Object.keys(recorded).length} contracts`);
    }
}
process.exit(process.exitCode ?? 0);

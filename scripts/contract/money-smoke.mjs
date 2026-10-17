#!/usr/bin/env node
/**
 * BE-20 rollout check: real money flows on STAGING, recorded as shapes so a LIVE_LEDGER_MODE=local
 * run and a remote run can be compared. Spends the QA accounts' staging coins (never production).
 *
 *   node scripts/contract/money-smoke.mjs run <out.json>        # one pass in whatever mode staging is in
 *   node scripts/contract/money-smoke.mjs compare <a.json> <b.json>
 *
 * Flow: host goes live, viewer joins, sends a normal gift, sends a gift twice with one clientTxId
 * (second must be 409 IDEM_CONFLICT), a single lucky gift, a global message, then the host ends.
 * Same env as run.mjs (CONTRACT_LIVE_BASE / CONTRACT_API_BASE / CONTRACT_HOST_ID / CONTRACT_VIEWER_ID).
 */
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { createRequire } from "module";
import { shapeOf, mergeShapes, compareShapes } from "./shape.mjs";

const require = createRequire(import.meta.url);
const { io } = require("socket.io-client");

const LIVE = process.env.CONTRACT_LIVE_BASE || "https://live-staging.offoolive.com";
const API = process.env.CONTRACT_API_BASE || "https://api-staging.offoolive.com/api/v1";
const PASSWORD = process.env.CONTRACT_PASSWORD || "ValidPass1!";
const HOST_ID = process.env.CONTRACT_HOST_ID || "34216594";
const VIEWER_ID = process.env.CONTRACT_VIEWER_ID || "34216589";

const PROD_HOSTS = new Set(["live.offoolive.com", "api.offoolive.com", "offoolive.com"]);
if ([LIVE, API].some((u) => PROD_HOSTS.has(new URL(u).hostname))) {
    console.error("Refusing to run money flows against production.");
    process.exit(2);
}

const [mode, a, b] = process.argv.slice(2);

if (mode === "compare") {
    const A = JSON.parse(fs.readFileSync(a, "utf8"));
    const B = JSON.parse(fs.readFileSync(b, "utf8"));
    const problems = [];
    for (const [name, rec] of Object.entries(A.observed)) {
        const now = B.observed[name];
        if (!now) {
            problems.push(`${name}: missing in ${path.basename(b)}`);
            continue;
        }
        if (rec.status !== now.status) problems.push(`${name}: status ${rec.status} -> ${now.status}`);
        for (const p of compareShapes(rec.shape, now.shape)) problems.push(`${name}: ${p}`);
        for (const p of compareShapes(now.shape, rec.shape)) problems.push(`${name} (reverse): ${p}`);
    }
    for (const name of Object.keys(B.observed)) if (!A.observed[name]) problems.push(`${name}: only in ${path.basename(b)}`);
    console.log("values A:", JSON.stringify(A.values));
    console.log("values B:", JSON.stringify(B.values));
    if (problems.length) {
        console.error(`DIFFERENCES (${problems.length}):\n  ` + problems.join("\n  "));
        process.exit(1);
    }
    console.log(`same shapes and statuses: ${Object.keys(A.observed).length} entries`);
    process.exit(0);
}
if (mode !== "run" || !a) {
    console.error("usage: money-smoke.mjs run <out.json> | compare <a.json> <b.json>");
    process.exit(2);
}

const observed = {};
const values = {};
const note = (name, status, body) => {
    const shape = shapeOf(body);
    const prev = observed[name];
    observed[name] = { status, shape: prev ? mergeShapes(prev.shape, shape) : shape };
};

const http = async (name, method, url, { token, body } = {}) => {
    const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000)
    });
    let json = null;
    try {
        json = await res.json();
    } catch {}
    if (name) note(name, res.status, json);
    return { status: res.status, json };
};

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
    if (cached && jwtPayload(cached).exp * 1000 > Date.now() + 5 * 60 * 1000) return { token: cached, userId: jwtPayload(cached).userId };
    const r = await http(null, "POST", `${API}/auth/login/password`, {
        body: { provider: "publicId", identifier: publicId, password: PASSWORD, deviceName: "live-contract", deviceId: `live-contract-${publicId}` }
    });
    const token = r.json?.data?.accessToken ?? r.json?.accessToken;
    if (!token) throw new Error(`login failed for ${publicId}: HTTP ${r.status}`);
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

const host = await login(HOST_ID);
const viewer = await login(VIEWER_ID);
const H = { token: host.token };
const V = { token: viewer.token };

const gifts = (await http(null, "GET", `${LIVE}/api/live-stream/gifts?page=1&limit=200`, V)).json?.data ?? [];
// Same rule as isLuckyGift: the flag, or a category named or slugged "lucky".
const isLucky = (g) =>
    g.isLucky ||
    String(g.gift_categories?.name ?? "").toLowerCase() === "lucky" ||
    String(g.gift_categories?.slug ?? "").toLowerCase() === "lucky";
const plain = gifts.filter((g) => g.isActive && !isLucky(g) && !g.vip_only).sort((x, y) => x.coinCost - y.coinCost)[0];
const lucky = gifts.filter((g) => g.isActive && isLucky(g)).sort((x, y) => x.coinCost - y.coinCost)[0];
if (!plain || !lucky) throw new Error("need one active normal gift and one active lucky gift on staging");
const before = (await http(null, "GET", `${LIVE}/api/live-stream/wallet/balance`, V)).json?.balance ?? 0;
const need = plain.coinCost * 3 + lucky.coinCost + 10_000;
if (before < need) throw new Error(`viewer has ${before} coins on staging, needs ${need}`);
values.gifts = { plain: plain.coinCost, lucky: lucky.coinCost };

const hs = await connect("host", host);
const vs = await connect("viewer", viewer);
const live = await http("POST /live-stream/go-live", "POST", `${LIVE}/api/live-stream/go-live`, { ...H, body: { title: "money smoke", heading: "qa" } });
const dbId = live.json?.data?.id;
const streamId = live.json?.data?.streamId;
if (!dbId) throw new Error(`go-live failed: HTTP ${live.status}`);
try {
    hs.emit("join_stream", { streamId });
    hs.emit("toggle_camera_state", { streamId, isCameraOn: true });
    await http(null, "POST", `${LIVE}/api/live-stream/join/${dbId}`, { ...V, body: {} });
    vs.emit("join_stream", { streamId });
    await wait(1500);

    const g1 = await http("POST /live-stream/:id/send-gift", "POST", `${LIVE}/api/live-stream/${dbId}/send-gift`, { ...V, body: { giftId: plain.id, count: 1 } });
    values.giftPoints = g1.json?.data?.socketPayload?.pointsAwarded ?? g1.json?.socketPayload?.pointsAwarded ?? null;

    const clientTxId = crypto.randomUUID();
    await http("POST /live-stream/:id/send-gift (clientTxId)", "POST", `${LIVE}/api/live-stream/${dbId}/send-gift`, { ...V, body: { giftId: plain.id, count: 1, clientTxId } });
    const dup = await http("POST /live-stream/:id/send-gift (same clientTxId)", "POST", `${LIVE}/api/live-stream/${dbId}/send-gift`, { ...V, body: { giftId: plain.id, count: 1, clientTxId } });
    values.duplicate = { status: dup.status, code: dup.json?.code ?? null };

    await http("POST /live-stream/:id/send-gift (lucky)", "POST", `${LIVE}/api/live-stream/${dbId}/send-gift`, { ...V, body: { giftId: lucky.id, count: 1 } });
    await http("POST /live-stream/global-message", "POST", `${LIVE}/api/live-stream/global-message`, { ...V, body: { message: "money smoke", streamId: dbId } });
    await wait(2000);
} finally {
    await http(null, "POST", `${LIVE}/api/live-stream/end/${dbId}`, { ...H, body: {} });
    hs.close();
    vs.close();
}
const after = (await http(null, "GET", `${LIVE}/api/live-stream/wallet/balance`, V)).json?.balance ?? 0;
values.spent = before - after;
fs.writeFileSync(a, JSON.stringify({ at: new Date().toISOString(), against: LIVE, values, observed }, null, 2));
console.log(`wrote ${Object.keys(observed).length} entries to ${a}; values ${JSON.stringify(values)}`);
process.exit(0);

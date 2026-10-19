/**
 * Latency baseline for Live-server's hot read paths (+ one ol-api read), STAGING ONLY.
 *
 *   k6 run scripts/load/baseline.k6.js                       # 20 rps then 60 rps, ~3.5 min
 *   k6 run -e OUT=baseline-2026-10-19.json scripts/load/baseline.k6.js
 *
 * Same env names as scripts/contract/*.mjs (CONTRACT_LIVE_BASE, CONTRACT_API_BASE,
 * CONTRACT_HOST_ID, CONTRACT_VIEWER_ID, CONTRACT_PASSWORD). Reports p50/p95/p99 per endpoint, so a
 * later run (after an infra or code change) can be compared like for like. A live stream can't be
 * held open from k6 (the host never joins LiveKit, so the ghost sweep ends it), so chat send and
 * heartbeats are not part of this mix; the contract and money tests cover them.
 */
import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";
import encoding from "k6/encoding";

const LIVE = __ENV.CONTRACT_LIVE_BASE || "https://live-staging.offoolive.com";
const API = __ENV.CONTRACT_API_BASE || "https://api-staging.offoolive.com/api/v1";
const PASSWORD = __ENV.CONTRACT_PASSWORD || "ValidPass1!";
const HOST_ID = __ENV.CONTRACT_HOST_ID || "34216594";
const VIEWER_ID = __ENV.CONTRACT_VIEWER_ID || "34216589";
const LOW = Number(__ENV.LOW_RPS || 20);
const HIGH = Number(__ENV.HIGH_RPS || 60);
const DUR = __ENV.DURATION || "90s";
const START = `${parseInt(DUR, 10) + 10}s`;

for (const u of [LIVE, API]) {
    if (/(^|\/\/)(live|api)\.offoolive\.com|\/\/offoolive\.com/.test(u)) throw new Error("Refusing to load-test production.");
}

export const options = {
    discardResponseBodies: false,
    scenarios: {
        low: { executor: "constant-arrival-rate", rate: LOW, timeUnit: "1s", duration: DUR, preAllocatedVUs: 20, maxVUs: 60, tags: { stage: "low" } },
        high: { executor: "constant-arrival-rate", rate: HIGH, timeUnit: "1s", duration: DUR, startTime: START, preAllocatedVUs: 60, maxVUs: 200, tags: { stage: "high" } }
    },
    summaryTrendStats: ["p(50)", "p(95)", "p(99)", "max", "count"]
};

// Weighted mix, roughly what the app does while browsing and watching.
const MIX = [
    ["feed", 25, (c) => `${LIVE}/api/live-stream/list?page=1&limit=20`],
    ["feed_country", 10, (c) => `${LIVE}/api/live-stream/list?page=1&limit=20&country=India`],
    ["gifts", 15, (c) => `${LIVE}/api/live-stream/gifts?page=1&limit=200`],
    ["vc_gifts", 5, (c) => `${LIVE}/api/video-call/gifts`],
    ["wallet", 15, (c) => `${LIVE}/api/live-stream/wallet/balance`],
    ["stream_detail", 10, (c) => c.streamId && `${LIVE}/api/live-stream/${c.streamId}`],
    ["stream_messages", 5, (c) => c.streamId && `${LIVE}/api/live-stream/${c.streamId}/messages`],
    ["fans_ranking", 5, (c) => `${LIVE}/api/live-stream/fans-ranking/${c.hostUserId}`],
    ["api_me", 10, (c) => `${API}/users/me`]
];
const TOTAL = MIX.reduce((s, m) => s + m[1], 0);
const trends = Object.fromEntries(MIX.map(([name]) => [name, new Trend(`t_${name}`, true)]));

const login = (publicId) => {
    const r = http.post(
        `${API}/auth/login/password`,
        JSON.stringify({ provider: "publicId", identifier: publicId, password: PASSWORD, deviceName: "k6-baseline", deviceId: `k6-baseline-${publicId}` }),
        { headers: { "content-type": "application/json" } }
    );
    const j = r.json();
    const token = j?.data?.accessToken ?? j?.accessToken;
    if (!token) throw new Error(`login failed for ${publicId}: HTTP ${r.status}`);
    const payload = JSON.parse(encoding.b64decode(token.split(".")[1], "rawurl", "s"));
    return { token, userId: payload.userId };
};

export function setup() {
    const host = login(HOST_ID);
    const viewer = login(VIEWER_ID);
    // A stream id for the per-stream reads: a live one if staging has any, else a short stream the
    // QA host starts and ends at once (ended streams still answer 200, through the same queries).
    const feed = http.get(`${LIVE}/api/live-stream/list?page=1&limit=1`, { headers: { authorization: `Bearer ${viewer.token}` } }).json();
    let streamId = feed?.data?.[0]?.streamId ?? null;
    if (!streamId) {
        const H = { headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" } };
        const live = http.post(`${LIVE}/api/live-stream/go-live`, JSON.stringify({ title: "k6 baseline", heading: "qa" }), H).json();
        streamId = live?.data?.streamId ?? null;
        if (live?.data?.id) http.post(`${LIVE}/api/live-stream/end/${live.data.id}`, "{}", H);
    }
    return { token: viewer.token, hostUserId: host.userId, streamId };
}

export default function (ctx) {
    let pick = Math.random() * TOTAL;
    let entry = MIX[0];
    for (const m of MIX) {
        pick -= m[1];
        if (pick <= 0) { entry = m; break; }
    }
    const [name, , urlFor] = entry;
    const url = urlFor(ctx) || `${LIVE}/api/live-stream/list?page=1&limit=20`;
    const r = http.get(url, { headers: { authorization: `Bearer ${ctx.token}` }, tags: { name } });
    trends[name].add(r.timings.duration);
    const ok = check(r, { [`${name} 2xx`]: (x) => x.status >= 200 && x.status < 300 });
    if (!ok && sampled < 3) {
        sampled += 1;
        console.warn(`${name} -> ${r.status} ${String(r.body || "").slice(0, 160)}`);
    }
}
let sampled = 0; // per VU: a few failing responses are printed, not all of them

export function handleSummary(data) {
    const rows = MIX.map(([name]) => {
        const v = data.metrics[`t_${name}`]?.values || {};
        return { name, count: v.count || 0, p50: v["p(50)"], p95: v["p(95)"], p99: v["p(99)"], max: v.max };
    });
    const fails = data.metrics.checks?.values?.fails ?? 0;
    const failedChecks = (data.root_group?.checks || []).filter((c) => c.fails > 0).map((c) => `${c.name}: ${c.fails}`);
    const out = { at: new Date().toISOString(), live: LIVE, api: API, lowRps: LOW, highRps: HIGH, checkFails: fails, endpoints: rows,
        overall: data.metrics.http_req_duration?.values };
    const fmt = (n) => (n === undefined ? "-" : n.toFixed(1)).padStart(8);
    const text = ["endpoint            count     p50     p95     p99     max (ms)",
        ...rows.map((r) => `${r.name.padEnd(16)}${String(r.count).padStart(8)}${fmt(r.p50)}${fmt(r.p95)}${fmt(r.p99)}${fmt(r.max)}`),
        `check failures: ${fails}${failedChecks.length ? ` (${failedChecks.join(", ")})` : ""}`].join("\n");
    const res = { stdout: text + "\n" };
    if (__ENV.OUT) res[__ENV.OUT] = JSON.stringify(out, null, 2);
    return res;
}

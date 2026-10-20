/**
 * BE-20 (option B): client for ol-node-rest's internal ledger API (`/internal/v1/ledger/*`).
 *
 * ol-node-rest is the single money service: every operation's coin/point ledger rows, levels and
 * agency commission are written there, in one locked transaction; Live-server keeps the socket
 * events and the UX. Operations: GIFT_LIVE | GIFT_VIDEO_CALL | LUCKY_GIFT | CALL_ACCEPT |
 * CALL_MINUTE | GLOBAL_MESSAGE.
 *
 * Live-server's own (local) copy of these transactions and the LIVE_LEDGER_MODE* switches were
 * retired on 2026-10-21, after every operation had run remote on production since 2026-10-17.
 *   LIVE_LEDGER_BASE_URL          default http://127.0.0.1:3101 (ol-node-rest internal listener)
 *   INTERNAL_LEDGER_HMAC_SECRET   shared with ol-node-rest; production refuses to boot without it
 *                                 (config/assertProductionConfig.js)
 *
 * Transport: keep-alive (Node's fetch pools connections), 3 s timeout per attempt, and retries only
 * for a network error, a timeout or 502/503/504, always with the same requestId, so a retry of a
 * request that did commit gets its committed result back instead of a second charge.
 */
import crypto from "crypto";

export const LEDGER_OPS = ["GIFT_LIVE", "GIFT_VIDEO_CALL", "LUCKY_GIFT", "CALL_ACCEPT", "CALL_MINUTE", "GLOBAL_MESSAGE"];

const ATTEMPT_TIMEOUT_MS = 3000;
const RETRY_DELAYS_MS = [100, 300];
const RETRY_STATUS = new Set([502, 503, 504]);

const secret = () => process.env.INTERNAL_LEDGER_HMAC_SECRET || "";
const baseUrl = () => (process.env.LIVE_LEDGER_BASE_URL || "http://127.0.0.1:3101").replace(/\/+$/, "");

/** Same scheme as ol-node-rest src/internal/hmac.ts. */
export const signRequest = (key, { timestamp, method, path, body }) =>
    `v1=${crypto.createHmac("sha256", key).update(`${timestamp}.${method.toUpperCase()}.${path}.${body}`).digest("hex")}`;

/** Error from the ledger API, shaped like the local path's errors (message, code, status). */
export class LedgerError extends Error {
    constructor(message, { code = null, status = null, details = null } = {}) {
        super(message);
        this.name = "LedgerError";
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

// Counters, logged every 10 minutes, so remote mode shows latency and failures at a glance.
const stats = {};
let statsWindow = Date.now();
const record = (op, outcome, ms) => {
    const s = (stats[op] ||= { n: 0, ms: 0, max: 0 });
    s.n += 1;
    s.ms += ms;
    s.max = Math.max(s.max, ms);
    s[outcome] = (s[outcome] || 0) + 1;
    if (Date.now() - statsWindow >= 10 * 60 * 1000) {
        const out = {};
        for (const [k, v] of Object.entries(stats)) out[k] = { ...v, avgMs: Math.round(v.ms / v.n) };
        console.log(`[Ledger] last 10m: ${JSON.stringify(out)}`);
        for (const k of Object.keys(stats)) delete stats[k];
        statsWindow = Date.now();
    }
};

/**
 * POST one operation. `body.requestId` is set here once and reused by every retry.
 * @returns {Promise<object>} the parsed response
 * @throws {LedgerError} with the API's `code` and `status` (status null = transport failure)
 */
export const callLedger = async (op, path, payload, { fetchImpl = fetch } = {}) => {
    const key = secret();
    const urlPath = `/internal/v1/ledger/${path}`;
    const body = JSON.stringify({ requestId: crypto.randomUUID(), ...payload });
    const started = Date.now();
    let lastErr = null;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
        const timestamp = String(Date.now());
        let res;
        try {
            res = await fetchImpl(`${baseUrl()}${urlPath}`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-ol-timestamp": timestamp,
                    "x-ol-signature": signRequest(key, { timestamp, method: "POST", path: urlPath, body })
                },
                body,
                keepalive: true,
                signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)
            });
        } catch (err) {
            lastErr = new LedgerError(`Ledger service unreachable: ${err.message}`, { code: "LEDGER_UNAVAILABLE" });
            continue;
        }
        if (RETRY_STATUS.has(res.status)) {
            lastErr = new LedgerError(`Ledger service unavailable (${res.status})`, { code: "LEDGER_UNAVAILABLE", status: res.status });
            continue;
        }
        let json = null;
        try {
            json = await res.json();
        } catch {
            json = null;
        }
        if (res.ok) {
            record(op, json?.replayed ? "replayed" : "ok", Date.now() - started);
            return json;
        }
        record(op, json?.code || `http_${res.status}`, Date.now() - started);
        throw new LedgerError(json?.message || `Ledger error ${res.status}`, {
            code: json?.code || null,
            status: res.status,
            details: json?.details || null
        });
    }
    record(op, "unavailable", Date.now() - started);
    console.error(`[Ledger] ${op} failed after retries: ${lastErr?.message}`);
    throw lastErr;
};

/**
 * Turn a ledger error into the exact Error the local path throws, so controllers (which match on
 * message text and on code P2002) answer the app exactly as before.
 * @param {LedgerError} err
 * @param {{ insufficient: string | ((details: object) => string), notFound?: string, notActive?: string, invalidState?: string }} messages
 */
export const toLocalError = (err, messages) => {
    if (!(err instanceof LedgerError)) return err;
    switch (err.code) {
        case "INSUFFICIENT_COINS": {
            const m = messages.insufficient;
            return new Error(typeof m === "function" ? m(err.details || {}) : m);
        }
        case "PERSONAL_COINS_FROZEN":
            return new Error("Your personal coins are currently frozen by admin.");
        case "DUPLICATE_LEDGER_KEY": {
            // Same signal the local path gives on a reused idempotency key (Prisma unique violation).
            const e = new Error("Duplicate gift send (already processed)");
            e.code = "P2002";
            return e;
        }
        case "GIFT_NOT_FOUND":
            return new Error(messages.notFound || "Gift not found or is inactive.");
        case "CALL_NOT_ACTIVE":
            return new Error(messages.notActive || "Video call session is not active.");
        case "INVALID_CALL_STATE":
            return new Error(messages.invalidState || "Invalid session or unauthorized.");
        default:
            return err;
    }
};

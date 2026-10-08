/**
 * Go-live / join failure log (backlog LIVE-06).
 *
 * Before this, a rejected /go-live or /join returned 400 with no log line, and a host
 * whose LiveKit Room.connect failed left no trace except a ghost-sweep end 20s later,
 * so the cause of a "can't go live" report had to be inferred from DB timings.
 *
 * Every event is:
 *   1. printed as one `[LiveFailure]` line (pm2 logs / grep), and
 *   2. kept in a capped Redis list so the admin panel can show recent failures
 *      (Live moderation -> "Go-live / join failures").
 *
 * Redis keys (shared Redis, no prefix):
 *   live:failures                  LIST, newest first, capped at MAX_EVENTS, no TTL
 *   live:failures:daily:<YYYY-MM-DD>  HASH kind -> count (UTC day), TTL 35 days
 *   live:failures:rl:<userId>      STRING counter for client reports, TTL 60s
 *
 * Recording is best-effort and never throws into the request path.
 */
import crypto from 'crypto';
import prisma from '../config/prisma.js';
import { client as redisClient } from '../config/redis.js';

export const LIVE_FAILURE_KINDS = Object.freeze({
    /** POST /live-stream/go-live returned non-2xx (validation, ban, service error). */
    GO_LIVE_REJECTED: 'GO_LIVE_REJECTED',
    /** POST /live-stream/join/:id returned non-2xx (not found, not live, kicked, password, error). */
    JOIN_REJECTED: 'JOIN_REJECTED',
    /** The app reported that LiveKit Room.connect failed (POST /live-stream/connect-failure). */
    CLIENT_CONNECT_FAILED: 'CLIENT_CONNECT_FAILED',
    /** Ghost sweep ended a stream whose host never appeared in the LiveKit room. */
    GHOST_STREAM_ENDED: 'GHOST_STREAM_ENDED',
    /** Heartbeat monitor ended a stream after the host stopped pinging. */
    HEARTBEAT_LOST: 'HEARTBEAT_LOST',
});

const KIND_SET = new Set(Object.values(LIVE_FAILURE_KINDS));

const LIST_KEY = 'live:failures';
const MAX_EVENTS = 5000;
const DAILY_TTL_SECONDS = 35 * 86400;
const dailyKey = (day) => `live:failures:daily:${day}`;
const rateKey = (userId) => `live:failures:rl:${userId}`;

/** Client reports allowed per user per minute (a crash loop must not flood the list). */
export const CLIENT_REPORT_RATE_PER_MIN = 20;

const clip = (value, max) => {
    if (value === undefined || value === null) return null;
    const s = String(value);
    return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** Keep `meta` small and flat: primitives only, short strings, at most 20 keys. */
const sanitizeMeta = (meta) => {
    if (!meta || typeof meta !== 'object') return null;
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(meta)) {
        if (n >= 20) break;
        if (v === undefined || v === null || v === '') continue;
        if (typeof v === 'number' || typeof v === 'boolean') out[clip(k, 40)] = v;
        else if (typeof v === 'string') out[clip(k, 40)] = clip(v, 200);
        else continue;
        n += 1;
    }
    return n > 0 ? out : null;
};

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

/**
 * Record one failure event. Fire-and-forget: returns immediately, never throws.
 * @param {{ kind: string, userId?: string|null, streamId?: string|null, status?: number|null,
 *           code?: string|null, message?: string|null, meta?: object|null }} evt
 */
export const recordLiveFailure = (evt) => {
    try {
        if (!evt || !KIND_SET.has(evt.kind)) return;
        const event = {
            id: crypto.randomUUID(),
            at: new Date().toISOString(),
            kind: evt.kind,
            userId: evt.userId || null,
            streamId: evt.streamId || null,
            status: Number.isFinite(evt.status) ? evt.status : null,
            code: clip(evt.code, 60),
            message: clip(evt.message, 300),
            meta: sanitizeMeta(evt.meta),
        };

        console.warn(
            `[LiveFailure] ${event.kind} status=${event.status ?? '-'} code=${event.code ?? '-'} ` +
            `user=${event.userId ?? '-'} stream=${event.streamId ?? '-'} msg=${JSON.stringify(event.message ?? '')}` +
            (event.meta ? ` meta=${JSON.stringify(event.meta)}` : '')
        );

        if (!redisClient.isOpen) return;
        const day = dailyKey(utcDay());
        redisClient
            .multi()
            .lPush(LIST_KEY, JSON.stringify(event))
            .lTrim(LIST_KEY, 0, MAX_EVENTS - 1)
            .hIncrBy(day, event.kind, 1)
            .expire(day, DAILY_TTL_SECONDS)
            .exec()
            .catch((err) => console.error('[LiveFailure] redis write failed:', err.message));
    } catch (err) {
        console.error('[LiveFailure] record failed:', err.message);
    }
};

/**
 * True when this user may file another client report this minute.
 * Fails open when Redis is down (the report is still only a log line then).
 */
export const allowClientFailureReport = async (userId) => {
    if (!userId || !redisClient.isOpen) return true;
    try {
        const key = rateKey(userId);
        const n = await redisClient.incr(key);
        if (n === 1) await redisClient.expire(key, 60);
        return n <= CLIENT_REPORT_RATE_PER_MIN;
    } catch {
        return true;
    }
};

const readEvents = async () => {
    if (!redisClient.isOpen) return [];
    const raw = await redisClient.lRange(LIST_KEY, 0, MAX_EVENTS - 1);
    const out = [];
    for (const r of raw) {
        try {
            out.push(JSON.parse(r));
        } catch {
            // skip a corrupt entry
        }
    }
    return out;
};

const dailySummary = async (days) => {
    if (!redisClient.isOpen) return [];
    const now = Date.now();
    const result = [];
    for (let i = 0; i < days; i += 1) {
        const day = utcDay(new Date(now - i * 86400000));
        const counts = await redisClient.hGetAll(dailyKey(day));
        const byKind = {};
        let total = 0;
        for (const kind of KIND_SET) {
            const c = Number(counts?.[kind] || 0);
            byKind[kind] = c;
            total += c;
        }
        result.push({ day, total, byKind });
    }
    return result;
};

/**
 * Admin listing, newest first. Filters run over the capped list (at most MAX_EVENTS).
 * @param {{ kind?: string, userId?: string, streamId?: string, code?: string,
 *           page?: number, limit?: number }} q
 */
export const listLiveFailures = async (q = {}) => {
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 50));
    const kind = q.kind && KIND_SET.has(q.kind) ? q.kind : null;
    const userId = q.userId ? String(q.userId).trim() : null;
    const streamId = q.streamId ? String(q.streamId).trim() : null;
    const code = q.code ? String(q.code).trim().toUpperCase() : null;

    const all = await readEvents();
    const filtered = all.filter(
        (e) =>
            (!kind || e.kind === kind) &&
            (!userId || e.userId === userId) &&
            (!streamId || e.streamId === streamId) &&
            (!code || (e.code || '').toUpperCase() === code)
    );
    const items = filtered.slice((page - 1) * limit, page * limit);

    // Attach a display name for the page's users (one query, page-sized).
    const ids = [...new Set(items.map((e) => e.userId).filter(Boolean))];
    let users = new Map();
    if (ids.length > 0) {
        try {
            const rows = await prisma.user.findMany({
                where: { id: { in: ids } },
                select: { id: true, username: true, firstName: true, lastName: true, country: true },
            });
            users = new Map(rows.map((u) => [u.id, u]));
        } catch (err) {
            console.error('[LiveFailure] user lookup failed:', err.message);
        }
    }

    return {
        items: items.map((e) => {
            const u = e.userId ? users.get(e.userId) : null;
            return {
                ...e,
                user: u
                    ? {
                        id: u.id,
                        username: u.username,
                        name: [u.firstName, u.lastName].filter(Boolean).join(' ') || null,
                        country: u.country || null,
                    }
                    : null,
            };
        }),
        pagination: { page, limit, total: filtered.length },
        retained: all.length,
        maxRetained: MAX_EVENTS,
        kinds: [...KIND_SET],
        summary: await dailySummary(7),
    };
};

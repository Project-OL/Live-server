/**
 * Go-live / join / call / app failure log (backlog LIVE-06; crash & reconnect hardening BE-01..03, BE-10).
 *
 * Before this, a rejected /go-live or /join returned 400 with no log line, and a host
 * whose LiveKit Room.connect failed left no trace except a ghost-sweep end 20s later,
 * so the cause of a "can't go live" report had to be inferred from DB timings.
 *
 * Every event is:
 *   1. printed as one `[LiveFailure] <KIND> sev=<S>` warn line, shipped to Cloud Logging (pm2_errors),
 *      where the log-based metric live_failures_s0_s1 alerts on S0/S1;
 *   2. kept in a capped Redis list so the admin panel can show recent failures
 *      (Live moderation -> "Go-live / join failures");
 *   3. stored in Postgres `live_failure_events` (90 days) for history and joins with streams/calls.
 *
 * Event shape (BE-01): the original fields (id, at, kind, userId, streamId, status, code, message,
 * meta) plus area (stream | call | socket | app), failureCode (= code), severity (S0..S4),
 * source (server | app), role, callId, occurredAt (client time for app reports) and receivedAt.
 *
 * Redis keys (shared Redis, no prefix):
 *   live:failures                  LIST, newest first, capped at MAX_EVENTS, no TTL
 *   live:failures:daily:<YYYY-MM-DD>  HASH kind -> count and sev:<S> -> count (UTC day), TTL 35 days
 *   live:failures:rl:<userId>      STRING counter for client reports, TTL 60s
 *   live:failures:seen:<eventId>   STRING dedupe of app-reported event ids, TTL 8 days
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
    /** BE-07: the host ended within 30 s without ever publishing video (was logged as a normal end). */
    GOLIVE_ABANDONED: 'GOLIVE_ABANDONED',
    /** BE-07: a video call was ended by the heartbeat sweep (a side lost its network or app). */
    CALL_NET_LOST: 'CALL_NET_LOST',
    /** BE-07: an accepted call with a side that never reached LiveKit within 20 s. */
    CALL_CONNECT_FAIL: 'CALL_CONNECT_FAIL',
    /** BE-02: any event the app reports through POST /live-stream/client-events. */
    CLIENT_EVENT: 'CLIENT_EVENT',
});

const KIND_SET = new Set(Object.values(LIVE_FAILURE_KINDS));
export const FAILURE_AREAS = Object.freeze(['stream', 'call', 'socket', 'app']);
export const SEVERITIES = Object.freeze(['S0', 'S1', 'S2', 'S3', 'S4']);
const AREA_SET = new Set(FAILURE_AREAS);
const SEVERITY_SET = new Set(SEVERITIES);

const LIST_KEY = 'live:failures';
const MAX_EVENTS = 5000;
const DAILY_TTL_SECONDS = 35 * 86400;
const RETENTION_DAYS = 90;
const SEEN_TTL_SECONDS = 8 * 86400;
const dailyKey = (day) => `live:failures:daily:${day}`;
const rateKey = (userId) => `live:failures:rl:${userId}`;
const seenKey = (id) => `live:failures:seen:${id}`;

/** Client reports allowed per user per minute (a crash loop must not flood the list). */
export const CLIENT_REPORT_RATE_PER_MIN = 20;
/** BE-02: app events accepted per user per minute, and per batch. */
export const CLIENT_EVENTS_RATE_PER_MIN = 60;
export const CLIENT_EVENTS_MAX_BATCH = 50;
/** App events older than this are dropped (the offline queue keeps a week at most). */
const CLIENT_EVENT_MAX_AGE_MS = 7 * 86400 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

const AREA_BY_KIND = {
    GO_LIVE_REJECTED: 'stream',
    JOIN_REJECTED: 'stream',
    CLIENT_CONNECT_FAILED: 'stream',
    GHOST_STREAM_ENDED: 'stream',
    HEARTBEAT_LOST: 'stream',
    GOLIVE_ABANDONED: 'stream',
    CALL_NET_LOST: 'call',
    CALL_CONNECT_FAIL: 'call',
    CLIENT_EVENT: 'app',
};

/** Expected or user-driven outcomes: kept for funnels, never alerted on. */
const INFO_CODES = new Set([
    'LIVE_STREAM_START_BANNED', 'STREAM_NOT_FOUND', 'STREAM_NOT_LIVE', 'KICKED', 'BAD_PASSWORD',
    'CANCELLED_BY_USER', 'APP_BACKGROUNDED', 'STREAM_ENDED_BY_SERVER', 'NET_OFFLINE',
]);

/** Default severity for app-reported failure codes (taxonomy in the hardening plan). */
const APP_CODE_SEVERITY = {
    APP_CRASH_LOOP: 'S1',
    APP_STARTUP_FAIL: 'S1',
    APP_FATAL_NATIVE: 'S2',
    APP_FATAL_DART: 'S2',
    APP_ANR: 'S2',
    APP_OOM: 'S2',
    APP_UNCLEAN_EXIT: 'S2',
    APP_NONFATAL_DART: 'S3',
    HOST_NET_LOST: 'S1',
    HOST_APP_KILLED: 'S1',
    CALL_CONNECT_FAIL: 'S1',
    CALL_APP_KILLED: 'S1',
    NET_WEAK: 'S3',
    SOCKET_DROP: 'S3',
    VIEW_STALL: 'S3',
    NET_PATH_BLOCKED: 'S2',
    JOIN_RTC_FAIL: 'S2',
    VIEW_FALSE_HOST_GONE: 'S2',
    GOLIVE_CAMERA_HANDOVER: 'S2',
};
/** Crashes on a live or call screen hurt a running session: one level higher. */
const LIVE_OR_CALL_SCREENS = /live|call|go_?live/i;

const bump = (sev) => SEVERITIES[Math.max(0, SEVERITIES.indexOf(sev) - 1)];

/**
 * Severity for an event: an explicit valid one wins; otherwise the taxonomy default.
 * A host with more than 20 viewers, or an app crash on a live/call screen, is one level higher.
 */
export const deriveSeverity = ({ kind, code, severity, meta, role }) => {
    if (severity && SEVERITY_SET.has(severity)) return severity;
    const c = String(code || '').toUpperCase();
    let sev;
    if (INFO_CODES.has(c)) sev = 'S4';
    else if (kind === 'HEARTBEAT_LOST') sev = c === 'HOST_NO_VIDEO' ? 'S2' : 'S1';
    else if (kind === 'CALL_NET_LOST' || kind === 'CALL_CONNECT_FAIL') sev = 'S1';
    else if (kind === 'GO_LIVE_REJECTED' && c === 'VALIDATION') sev = 'S3';
    else if (kind === 'CLIENT_EVENT') {
        sev = APP_CODE_SEVERITY[c] || 'S3';
        if (/^APP_FATAL_|^APP_ANR$/.test(c) && LIVE_OR_CALL_SCREENS.test(String(meta?.screen || ''))) sev = bump(sev);
    } else sev = 'S2';
    if (sev !== 'S0' && role === 'host' && Number(meta?.viewers) > 20) sev = bump(sev);
    return sev;
};

const persist = (event) => {
    prisma.liveFailureEvent
        .create({
            data: {
                id: event.id,
                occurredAt: new Date(event.occurredAt),
                receivedAt: new Date(event.receivedAt),
                kind: event.kind,
                area: event.area,
                failureCode: clip(event.failureCode, 64) || 'UNKNOWN',
                severity: event.severity,
                source: event.source,
                userId: event.userId && UUID_RE.test(event.userId) ? event.userId : null,
                streamId: clip(event.streamId, 64),
                callId: clip(event.callId, 64),
                role: clip(event.role, 16),
                status: event.status,
                message: clip(event.message, 300),
                appVersion: clip(event.appVersion, 40),
                platform: clip(event.platform, 16),
                deviceModel: clip(event.deviceModel, 64),
                network: clip(event.network, 16),
                meta: event.meta ?? undefined,
            },
        })
        .catch((err) => console.warn('[LiveFailure] db write failed:', err.message));
};

/**
 * Record one failure event. Fire-and-forget: returns the event (or null), never throws.
 * @param {{ kind: string, userId?: string|null, streamId?: string|null, callId?: string|null,
 *           status?: number|null, code?: string|null, message?: string|null, meta?: object|null,
 *           area?: string, severity?: string, source?: 'server'|'app', role?: string|null,
 *           occurredAt?: string|Date, appVersion?: string, platform?: string,
 *           deviceModel?: string, network?: string, id?: string }} evt
 */
export const recordLiveFailure = (evt) => {
    try {
        if (!evt || !KIND_SET.has(evt.kind)) return null;
        const receivedAt = new Date().toISOString();
        const meta = sanitizeMeta(evt.meta);
        const role = evt.role ?? meta?.role ?? null;
        const event = {
            id: evt.id && UUID_RE.test(evt.id) ? evt.id : crypto.randomUUID(),
            at: receivedAt,
            kind: evt.kind,
            userId: evt.userId || null,
            streamId: evt.streamId || null,
            status: Number.isFinite(evt.status) ? evt.status : null,
            code: clip(evt.code, 60),
            message: clip(evt.message, 300),
            meta,
            // BE-01 additions
            area: evt.area && AREA_SET.has(evt.area) ? evt.area : AREA_BY_KIND[evt.kind] || 'app',
            failureCode: clip(evt.code, 60) || evt.kind,
            severity: deriveSeverity({ kind: evt.kind, code: evt.code, severity: evt.severity, meta, role }),
            source: evt.source === 'app' ? 'app' : 'server',
            role,
            callId: evt.callId || null,
            occurredAt: evt.occurredAt ? new Date(evt.occurredAt).toISOString() : receivedAt,
            receivedAt,
            appVersion: clip(evt.appVersion ?? meta?.appVersion, 40),
            platform: clip(evt.platform ?? meta?.platform, 16),
            deviceModel: clip(evt.deviceModel ?? meta?.deviceModel, 64),
            network: clip(evt.network ?? meta?.network, 16),
        };

        // Kind stays first after the tag: Cloud Monitoring metric live_streams_auto_ended matches
        // "[LiveFailure] (GHOST_STREAM_ENDED|HEARTBEAT_LOST)".
        const line =
            `[LiveFailure] ${event.kind} sev=${event.severity} status=${event.status ?? '-'} code=${event.code ?? '-'} ` +
            `user=${event.userId ?? '-'} stream=${event.streamId ?? '-'}` +
            (event.callId ? ` call=${event.callId}` : '') +
            ` src=${event.source} msg=${JSON.stringify(event.message ?? '')}` +
            (event.meta ? ` meta=${JSON.stringify(event.meta)}` : '');
        // BE-10: warn lines are shipped to Cloud Logging (log pm2_errors); the log-based metric
        // live_failures_s0_s1 counts `sev=S0|S1` and alerts. console.error would also open an Error
        // Reporting group per event, so every severity stays a warning.
        console.warn(line);

        persist(event);

        if (!redisClient.isOpen) return event;
        const day = dailyKey(utcDay());
        redisClient
            .multi()
            .lPush(LIST_KEY, JSON.stringify(event))
            .lTrim(LIST_KEY, 0, MAX_EVENTS - 1)
            .hIncrBy(day, event.kind, 1)
            .hIncrBy(day, `sev:${event.severity}`, 1)
            .expire(day, DAILY_TTL_SECONDS)
            .exec()
            .catch((err) => console.error('[LiveFailure] redis write failed:', err.message));
        return event;
    } catch (err) {
        console.error('[LiveFailure] record failed:', err.message);
        return null;
    }
};

/**
 * True when this user may file another client report this minute.
 * Fails open when Redis is down (the report is still only a log line then).
 */
export const allowClientFailureReport = async (userId, cost = 1, limit = CLIENT_REPORT_RATE_PER_MIN, bucket = '') => {
    if (!userId || !redisClient.isOpen) return true;
    try {
        const key = rateKey(userId) + (bucket ? `:${bucket}` : '');
        const n = await redisClient.incrBy(key, cost);
        if (n === cost) await redisClient.expire(key, 60);
        return n <= limit;
    } catch {
        return true;
    }
};

const str = (v, max) => (typeof v === 'string' && v.trim() ? clip(v.trim(), max) : undefined);
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : undefined);

/**
 * BE-02: validate and record one app-reported event. Returns 'ok' | 'duplicate' | a rejection reason.
 * Events the app queued offline arrive late, so `occurredAt` is the app's clock (up to 7 days old).
 */
export const recordClientEvent = async (userId, raw, headerAppVersion, now = Date.now()) => {
    if (!raw || typeof raw !== 'object') return 'not_an_object';
    const failureCode = str(raw.failureCode, 64);
    if (!failureCode || !/^[A-Z0-9_]{2,64}$/.test(failureCode)) return 'bad_failureCode';
    const area = str(raw.area, 16);
    if (!area || !AREA_SET.has(area)) return 'bad_area';
    const occurred = Date.parse(raw.occurredAt);
    if (!Number.isFinite(occurred)) return 'bad_occurredAt';
    if (occurred < now - CLIENT_EVENT_MAX_AGE_MS || occurred > now + 5 * 60_000) return 'occurredAt_out_of_range';
    const id = typeof raw.id === 'string' && UUID_RE.test(raw.id) ? raw.id.toLowerCase() : null;
    if (id && redisClient.isOpen) {
        try {
            const fresh = await redisClient.set(seenKey(id), '1', { NX: true, EX: SEEN_TTL_SECONDS });
            if (fresh === null) return 'duplicate';
        } catch {
            /* dedupe is best-effort */
        }
    }
    const role = ['host', 'viewer', 'caller', 'callee'].includes(raw.role) ? raw.role : null;
    recordLiveFailure({
        id: id || undefined,
        kind: LIVE_FAILURE_KINDS.CLIENT_EVENT,
        source: 'app',
        area,
        code: failureCode,
        severity: str(raw.severity, 2),
        userId,
        streamId: str(raw.streamId, 64) || null,
        callId: str(raw.callId, 64) || null,
        role,
        message: str(raw.message, 300) || null,
        occurredAt: new Date(occurred),
        appVersion: str(raw.appVersion, 40) || str(headerAppVersion, 40),
        platform: str(raw.platform, 16),
        deviceModel: str(raw.deviceModel, 64),
        network: str(raw.network, 16),
        meta: {
            phase: str(raw.phase, 40),
            screen: str(raw.screen, 60),
            attempt: num(raw.attempt),
            durationMs: num(raw.durationMs),
            osVersion: str(raw.osVersion, 20),
            sdkVersion: str(raw.sdkVersion, 40),
            exitReason: str(raw.exitReason, 40),
            crashId: str(raw.crashId, 64),
            viewers: num(raw.viewers),
        },
    });
    return 'ok';
};

/** Delete Postgres events older than the retention window (leader, once a day). */
export const pruneOldFailureEvents = async () => {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400 * 1000);
    const { count } = await prisma.liveFailureEvent.deleteMany({ where: { occurredAt: { lt: cutoff } } });
    if (count) console.log(`[LiveFailure] pruned ${count} events older than ${RETENTION_DAYS} days`);
    return count;
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
        const bySeverity = {};
        let total = 0;
        for (const kind of KIND_SET) {
            const c = Number(counts?.[kind] || 0);
            byKind[kind] = c;
            total += c;
        }
        for (const s of SEVERITIES) bySeverity[s] = Number(counts?.[`sev:${s}`] || 0);
        result.push({ day, total, byKind, bySeverity });
    }
    return result;
};

/**
 * Admin listing, newest first. Filters run over the capped list (at most MAX_EVENTS).
 * @param {{ kind?: string, userId?: string, streamId?: string, code?: string, severity?: string,
 *           area?: string, page?: number, limit?: number }} q
 */
export const listLiveFailures = async (q = {}) => {
    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 50));
    const kind = q.kind && KIND_SET.has(q.kind) ? q.kind : null;
    const userId = q.userId ? String(q.userId).trim() : null;
    const streamId = q.streamId ? String(q.streamId).trim() : null;
    const code = q.code ? String(q.code).trim().toUpperCase() : null;
    const severity = q.severity && SEVERITY_SET.has(q.severity) ? q.severity : null;
    const area = q.area && AREA_SET.has(q.area) ? q.area : null;

    const all = await readEvents();
    const filtered = all.filter(
        (e) =>
            (!kind || e.kind === kind) &&
            (!userId || e.userId === userId) &&
            (!streamId || e.streamId === streamId) &&
            (!code || (e.code || '').toUpperCase() === code) &&
            // Events recorded before BE-01 have no severity/area: they match no such filter.
            (!severity || e.severity === severity) &&
            (!area || e.area === area)
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
        severities: [...SEVERITIES],
        areas: [...FAILURE_AREAS],
        summary: await dailySummary(7),
    };
};

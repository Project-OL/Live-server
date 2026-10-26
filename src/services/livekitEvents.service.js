import { client as redisClient } from "../config/redis.js";
import { makeWindowLog, modeFromEnv } from "../utils/tokenBucket.js";

/**
 * OBS-07 / LIVE-43 groundwork: LiveKit webhook events, recorded without acting on them.
 *
 * LiveKit posts room and participant events to /api/video-call/webhook (signed; SEC-07). This keeps,
 * per room, who LiveKit says is in it right now (`lk:presence:<room>` hash: identity -> joinedAt ms,
 * 12 h TTL), and counts events every 10 minutes. Nothing here ends calls or streams; the only action
 * a webhook has ever triggered (ending a video call on room_finished) is gated by
 * LIVE_WEBHOOK_MODE in the controller (log by default).
 *
 * Later (LIVE-43) the heartbeat sweep can read this instead of asking LiveKit about every stream
 * every 5 s.
 */
const PRESENCE_TTL_SEC = 12 * 3600;
const EVENTS_TTL_SEC = 24 * 3600;
const EVENTS_MAX = 50;
const report = makeWindowLog("LiveKit Webhook");

export const presenceKey = (room) => `lk:presence:${room}`;
/** BE-06: last 50 join / leave / video-publish events of a room (JSON, newest first), 24 h TTL. */
export const roomEventsKey = (room) => `lk:events:${room}`;
export const webhookMode = () => modeFromEnv("LIVE_WEBHOOK_MODE"); // off | log | enforce

/**
 * LiveKit protocol DisconnectReason (livekit_models.proto); the SDK does not re-export it.
 * The SFU's close reasons map onto these: CLIENT_REQUEST_LEAVE -> CLIENT_INITIATED,
 * JOIN_TIMEOUT -> JOIN_FAILURE, SIGNAL_SOURCE_CLOSE -> SIGNAL_CLOSE, and so on.
 */
const DISCONNECT_REASONS = [
    "UNKNOWN_REASON", "CLIENT_INITIATED", "DUPLICATE_IDENTITY", "SERVER_SHUTDOWN",
    "PARTICIPANT_REMOVED", "ROOM_DELETED", "STATE_MISMATCH", "JOIN_FAILURE", "MIGRATION",
    "SIGNAL_CLOSE", "ROOM_CLOSED", "USER_UNAVAILABLE", "USER_REJECTED", "SIP_TRUNK_FAILURE",
    "CONNECTION_TIMEOUT", "MEDIA_FAILURE",
];
export const disconnectReasonName = (r) => {
    if (typeof r === "string") return r;
    return Number.isInteger(r) ? DISCONNECT_REASONS.at(r) ?? `REASON_${r}` : null;
};
/** Leaves that are not the user's choice (network, media, timeout, server). */
export const isAbnormalLeave = (reason) =>
    !!reason && !["CLIENT_INITIATED", "ROOM_DELETED", "ROOM_CLOSED", "PARTICIPANT_REMOVED", "DUPLICATE_IDENTITY"].includes(reason);

const isVideoTrack = (track) => track?.type === 1 || track?.type === "VIDEO";

export const recordLivekitEvent = async (event) => {
    const type = String(event?.event || "unknown");
    const room = event?.room?.name;
    const identity = event?.participant?.identity;
    report.count(type);
    if (!room || !redisClient.isOpen) return;
    // BE-06: a short per-room history so a failure can say "never reached LiveKit",
    // "reached but never published video" or "left LiveKit: <reason>".
    let short = null;
    if (identity && type === "participant_joined") short = "j";
    else if (identity && type === "participant_left") short = "l";
    else if (identity && type === "track_published" && isVideoTrack(event.track)) short = "v";
    if (short) {
        const entry = { e: short, id: identity, at: Date.now() };
        if (short === "l") entry.r = disconnectReasonName(event.participant?.disconnectReason);
        redisClient
            .multi()
            .lPush(roomEventsKey(room), JSON.stringify(entry))
            .lTrim(roomEventsKey(room), 0, EVENTS_MAX - 1)
            .expire(roomEventsKey(room), EVENTS_TTL_SEC)
            .exec()
            .catch((err) => report.detail("redis:events", `room events write failed: ${err.message}`));
    }
    try {
        if (type === "participant_joined" && identity) {
            await redisClient
                .multi()
                .hSet(presenceKey(room), identity, String(Date.now()))
                .expire(presenceKey(room), PRESENCE_TTL_SEC)
                .exec();
        } else if (type === "participant_left" && identity) {
            await redisClient.hDel(presenceKey(room), identity);
        } else if (type === "room_finished") {
            await redisClient.del(presenceKey(room));
        }
    } catch (err) {
        report.detail(`redis:${type}`, `presence update failed for ${type}: ${err.message}`);
    }
};

/**
 * BE-06: what LiveKit saw of one participant in a room, from the webhook history.
 * { joined, publishedVideo, joins, lastLeftReason, lastLeftAt, gone } (false/0/null when unknown);
 * gone = their newest join/leave event is a leave.
 */
export const hostStreamFacts = async (room, identity) => {
    const facts = { joined: false, publishedVideo: false, joins: 0, lastLeftReason: null, lastLeftAt: null, gone: false };
    if (!room || !identity || !redisClient.isOpen) return facts;
    try {
        const raw = await redisClient.lRange(roomEventsKey(room), 0, EVENTS_MAX - 1);
        let newest = true;
        for (const r of raw) {
            let e;
            try {
                e = JSON.parse(r);
            } catch {
                continue;
            }
            if (e.id !== identity) continue;
            // The list is newest first: the first join/leave seen says whether they are gone now.
            if (newest && (e.e === "j" || e.e === "l")) {
                facts.gone = e.e === "l";
                newest = false;
            }
            if (e.e === "j") {
                facts.joined = true;
                facts.joins += 1;
            } else if (e.e === "v") facts.publishedVideo = true;
            else if (e.e === "l" && facts.lastLeftAt === null) {
                facts.lastLeftAt = e.at;
                facts.lastLeftReason = e.r || null;
            }
        }
    } catch {
        /* facts stay unknown */
    }
    return facts;
};

/** One-word cause for a failure event's meta, from {@link hostStreamFacts}. */
export const livekitCause = (facts) => {
    if (!facts.joined) return "NEVER_REACHED_LIVEKIT";
    if (facts.gone) return `LEFT_LIVEKIT_${facts.lastLeftReason || "UNKNOWN_REASON"}`;
    if (!facts.publishedVideo) return "IN_LIVEKIT_NO_VIDEO";
    return "IN_LIVEKIT";
};

/** identity -> joinedAt (ms) for a room, from webhook events. Empty when unknown. */
export const getRoomPresence = async (room) => {
    if (!room || !redisClient.isOpen) return {};
    const raw = await redisClient.hGetAll(presenceKey(room));
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v)]));
};

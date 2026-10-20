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
const report = makeWindowLog("LiveKit Webhook");

export const presenceKey = (room) => `lk:presence:${room}`;
export const webhookMode = () => modeFromEnv("LIVE_WEBHOOK_MODE"); // off | log | enforce

export const recordLivekitEvent = async (event) => {
    const type = String(event?.event || "unknown");
    const room = event?.room?.name;
    const identity = event?.participant?.identity;
    report.count(type);
    if (!room || !redisClient.isOpen) return;
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

/** identity -> joinedAt (ms) for a room, from webhook events. Empty when unknown. */
export const getRoomPresence = async (room) => {
    if (!room || !redisClient.isOpen) return {};
    const raw = await redisClient.hGetAll(presenceKey(room));
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v)]));
};

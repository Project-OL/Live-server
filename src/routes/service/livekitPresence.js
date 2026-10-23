import { RoomServiceClient } from 'livekit-server-sdk';
import dotenv from 'dotenv';
import { client as redisClient } from '../../config/redis.js';
import { presenceKey } from '../../services/livekitEvents.service.js';
import { makeWindowLog, modeFromEnv } from '../../utils/tokenBucket.js';

dotenv.config();

const apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
const apiSecret = process.env.LIVEKIT_API_SECRET || 'secret';
const livekitHost = (process.env.LIVEKIT_URL || 'http://localhost:7880')
    .replace(/^wss:/i, 'https:')
    .replace(/^ws:/i, 'http:');

export const livekitRoomService = new RoomServiceClient(livekitHost, apiKey, apiSecret);

/**
 * LIVE-43: where the heartbeat sweep learns whether a host is in their LiveKit room.
 *
 *   LIVE_PRESENCE_MODE=off      ask LiveKit's API every time (the behaviour before LIVE-43)
 *   LIVE_PRESENCE_MODE=log      (default) the API answer is used; the webhook presence
 *                               (`lk:presence:<room>`, livekitEvents.service.js) is read alongside and
 *                               every agreement/disagreement is counted, with a line per disagreement
 *   LIVE_PRESENCE_MODE=enforce  the webhook presence is used, so the sweep stops calling LiveKit for
 *                               every stream every 5 s. A room with no webhook record at all (webhooks
 *                               not arriving, a room older than them, or the host's hash emptied)
 *                               still falls back to the API, so a webhook outage alone can't end a stream.
 * Flip to enforce only after the log shows no disagreements over a few days of real streams.
 */
export const presenceMode = () => modeFromEnv('LIVE_PRESENCE_MODE');

const report = makeWindowLog('LiveKit Presence');

/** LiveKit API: true when the host identity is in the room. Missing room / API errors => false. */
export const livekitApiHostIsPresent = async (roomName, hostUserId) => {
    try {
        const participants = await livekitRoomService.listParticipants(roomName);
        return (participants || []).some((p) => p.identity === hostUserId);
    } catch (_err) {
        return false;
    }
};

/**
 * Phase 0 black-screen gap: is the host publishing an unmuted video track? true/false, or null when
 * the host is not in the room or LiveKit can't be asked. TrackType VIDEO is 1 in the protocol enum.
 */
export const livekitHostPublishingVideo = async (roomName, hostUserId, list = (r) => livekitRoomService.listParticipants(r)) => {
    try {
        const host = (await list(roomName) || []).find((p) => p.identity === hostUserId);
        if (!host) return null;
        return (host.tracks || []).some((t) => (t.type === 1 || t.type === 'VIDEO') && !t.muted);
    } catch (_err) {
        return null;
    }
};

/** Webhook presence: true/false, or null when there is no webhook record for the room. */
export const webhookHostIsPresent = async (roomName, hostUserId) => {
    if (!redisClient.isOpen) return null;
    const key = presenceKey(roomName);
    const [exists, hit] = await Promise.all([redisClient.exists(key), redisClient.hExists(key, hostUserId)]);
    if (!Number(exists)) return null;
    return Boolean(Number(hit));
};

const defaultDeps = { mode: presenceMode, api: livekitApiHostIsPresent, webhook: webhookHostIsPresent };

/**
 * True when the host is in their LiveKit room (see LIVE_PRESENCE_MODE above).
 * Missing room / API errors => false, as before.
 */
export const livekitHostIsPresent = async (roomName, hostUserId, deps = defaultDeps) => {
    if (!roomName || !hostUserId) return false;
    const mode = deps.mode();
    if (mode === 'off') return deps.api(roomName, hostUserId);

    let fromWebhook = null;
    try {
        fromWebhook = await deps.webhook(roomName, hostUserId);
    } catch (_err) {
        fromWebhook = null;
    }
    if (mode === 'enforce' && fromWebhook !== null) {
        report.count('webhook');
        return fromWebhook;
    }

    const fromApi = await deps.api(roomName, hostUserId);
    if (fromWebhook === null) {
        report.count('no_webhook_record');
    } else if (fromWebhook === fromApi) {
        report.count('agree');
    } else {
        report.count(fromApi ? 'disagree_api_present' : 'disagree_api_absent');
        report.detail(
            `${roomName}:${fromApi}`,
            `room ${roomName} host ${hostUserId}: LiveKit API says ${fromApi ? 'present' : 'absent'}, webhooks say ${fromWebhook ? 'present' : 'absent'} (mode=${mode})`
        );
    }
    return fromApi;
};

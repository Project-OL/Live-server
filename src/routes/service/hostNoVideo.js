import { client as redisClient } from '../../config/redis.js';
import { livekitHostPublishingVideo } from './livekitPresence.js';

/**
 * Phase 0 black-screen gap: the host is in the LiveKit room (so LIVE-15 sees nothing wrong) but
 * publishes no unmuted video, and did not switch the camera off on purpose
 * (`stream:camera_off_at:<id>`, set by toggle_camera_state). Checked at most every 30 s per stream.
 *   LIVE_HOST_NOVIDEO_MODE=log      default: log what would be ended
 *   LIVE_HOST_NOVIDEO_MODE=enforce  end the stream (reason HOST_MEDIA_LOST)
 * LIVE_HOST_NOVIDEO_MAX_MS, default 5 minutes.
 */
export const HOST_NOVIDEO_MAX_MS = Number(process.env.LIVE_HOST_NOVIDEO_MAX_MS || 5 * 60 * 1000);
export const hostNoVideoMode = () =>
    String(process.env.LIVE_HOST_NOVIDEO_MODE || 'log').trim().toLowerCase() === 'enforce' ? 'enforce' : 'log';
export const hostNoVideoKey = (streamIdKey) => `stream:host_novideo_since:${streamIdKey}`;
const videoCheckedAt = new Map();

/**
 * @returns {Promise<number|null>} ms without video (null = not checked this tick, or video fine).
 */
export const hostNoVideoMs = async (streamIdKey, hostUserId, now, deps = { publishing: livekitHostPublishingVideo, redis: redisClient }) => {
    if (now - (videoCheckedAt.get(streamIdKey) || 0) < 30000) return null;
    videoCheckedAt.set(streamIdKey, now);
    if (videoCheckedAt.size > 5000) videoCheckedAt.clear();
    const r = deps.redis;
    if (!r?.isOpen) return null;
    const publishing = await deps.publishing(streamIdKey, hostUserId);
    const cameraOff = await r.get(`stream:camera_off_at:${streamIdKey}`);
    if (publishing !== false || cameraOff) {
        await r.del(hostNoVideoKey(streamIdKey));
        return null;
    }
    await r.set(hostNoVideoKey(streamIdKey), String(now), { NX: true, EX: 86400 });
    const since = Number(await r.get(hostNoVideoKey(streamIdKey)));
    return Number.isFinite(since) ? now - since : 0;
};

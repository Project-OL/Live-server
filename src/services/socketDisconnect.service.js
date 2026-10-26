/**
 * BE-05: the last socket.io disconnect of a user, so a later failure event (ghost stream,
 * heartbeat lost, call dropped) can say how the app's connection ended:
 *   "transport close"            the connection died (network gone, app killed)
 *   "ping timeout"               no pong for pingTimeout (network stalled, app frozen)
 *   "client namespace disconnect" the app closed it on purpose (backgrounded, logged out)
 *   "server namespace disconnect" / "server shutting down"  we closed it
 *
 * Redis: live:lastdisc:<userId> = JSON { reason, at, sid }, TTL 1 hour. Best-effort.
 */
import { client as redisClient } from '../config/redis.js';

const TTL_SEC = 3600;
const key = (userId) => `live:lastdisc:${userId}`;

export const noteDisconnect = (userId, reason, sid) => {
    if (!userId || !redisClient.isOpen) return;
    redisClient
        .set(key(userId), JSON.stringify({ reason: String(reason || 'unknown'), at: Date.now(), sid }), { EX: TTL_SEC })
        .catch(() => { });
};

/** { reason, at, agoMs } of the user's last disconnect within the hour, or null. */
export const lastDisconnect = async (userId, now = Date.now()) => {
    if (!userId || !redisClient.isOpen) return null;
    try {
        const raw = await redisClient.get(key(userId));
        if (!raw) return null;
        const d = JSON.parse(raw);
        return { reason: d.reason, at: d.at, agoMs: now - Number(d.at) };
    } catch {
        return null;
    }
};

/** Flat meta fields for a failure event (sanitizeMeta keeps primitives only). */
export const disconnectMeta = async (userId, now = Date.now()) => {
    const d = await lastDisconnect(userId, now);
    return d ? { socketDisconnect: d.reason, socketDisconnectAgoMs: d.agoMs } : {};
};

/**
 * BE-09: tell viewers and call partners when the other side's network is the problem, instead of
 * a frozen picture with no explanation (or a viewer popped to "host offline").
 *
 *   host_network  -> everyone in a live room   { streamId, state, reason? }
 *   peer_network  -> the other side of a call  { sessionId, userId, state, reason? }
 *   state: 'weak' | 'reconnecting' | 'back'
 *
 * Sources: LiveKit webhooks (participant_left with an abnormal reason -> reconnecting;
 * participant_joined after that -> back) and the app's own `network_quality` socket message
 * (poor/lost -> weak, good/excellent -> back). Only state changes are sent.
 *
 * LIVE_NETWORK_NOTICE_MODE: off | log (default: log line only) | enforce (also emit). Old apps
 * ignore unknown events, so enforce is safe; log first shows how often each would fire.
 */
import prisma from '../config/prisma.js';
import { client as redisClient } from '../config/redis.js';
import { modeFromEnv } from '../utils/tokenBucket.js';
import { isAbnormalLeave, disconnectReasonName } from './livekitEvents.service.js';
import { broadcastToStream } from '../routes/service/socket-live-service.js';
import { emitToUser } from '../modules/videoCall/socket.js';

const STATE_TTL_SEC = 600;
export const networkNoticeMode = () => modeFromEnv('LIVE_NETWORK_NOTICE_MODE');
const stateKey = (scope, id, userId) => `live:netstate:${scope}:${id}:${userId}`;

/** Store the new state; true only when it changed (so each change is sent once). */
const changeState = async (scope, id, userId, state) => {
    if (!redisClient.isOpen) return true;
    try {
        const prev = await redisClient.set(stateKey(scope, id, userId), state, { EX: STATE_TTL_SEC, GET: true });
        return prev !== state && !(state === 'back' && prev === null);
    } catch {
        return false;
    }
};

const send = (kind, target, event, payload) => {
    const mode = networkNoticeMode();
    if (mode === 'off') return;
    console.log(`[Network Notice] mode=${mode} ${event} ${kind}=${target} ${JSON.stringify(payload)}`);
    if (mode !== 'enforce') return;
    if (kind === 'stream') broadcastToStream(target, event, payload);
    else emitToUser(target, event, payload);
};

/** Live room host or call participant behind a LiveKit room + identity, or null. */
const resolveRoom = async (room, identity) => {
    const stream = await prisma.liveStream.findFirst({
        where: { streamId: room, isLive: true, endedAt: null },
        select: { streamId: true, userId: true },
    });
    if (stream) return stream.userId === identity ? { scope: 'stream', streamId: stream.streamId } : null;
    const call = await prisma.videoCallSession.findUnique({
        where: { livekitRoom: room },
        select: { id: true, status: true, callerId: true, creatorId: true },
    });
    if (!call || call.status !== 'ACTIVE') return null;
    if (identity === call.callerId) return { scope: 'call', sessionId: call.id, other: call.creatorId };
    if (identity === call.creatorId) return { scope: 'call', sessionId: call.id, other: call.callerId };
    return null;
};

/** Notify for one participant's state change. Never throws. */
export const noticeState = async (target, userId, state, reason) => {
    try {
        if (target.scope === 'stream') {
            if (!(await changeState('stream', target.streamId, userId, state))) return;
            send('stream', target.streamId, 'host_network', { streamId: target.streamId, state, ...(reason ? { reason } : {}) });
        } else {
            if (!(await changeState('call', target.sessionId, userId, state))) return;
            send('user', target.other, 'peer_network', { sessionId: target.sessionId, userId, state, ...(reason ? { reason } : {}) });
        }
    } catch (err) {
        console.warn('[Network Notice] failed:', err.message);
    }
};

/** From the LiveKit webhook (after recordLivekitEvent). */
export const handleLivekitNetworkEvent = async (event) => {
    if (networkNoticeMode() === 'off') return;
    const type = event?.event;
    const room = event?.room?.name;
    const identity = event?.participant?.identity;
    if (!room || !identity || (type !== 'participant_left' && type !== 'participant_joined')) return;
    let state;
    let reason = null;
    if (type === 'participant_left') {
        reason = disconnectReasonName(event.participant?.disconnectReason);
        if (!isAbnormalLeave(reason)) return;
        state = 'reconnecting';
    } else state = 'back';
    const target = await resolveRoom(room, identity);
    if (target) await noticeState(target, identity, state, reason);
};

/** From the app's `network_quality` socket message: { quality: excellent|good|poor|lost, sessionId? }. */
export const handleClientQuality = async (socket, data) => {
    if (networkNoticeMode() === 'off') return;
    const userId = socket.data?.authUserId;
    const quality = String(data?.quality || '').toLowerCase();
    if (!userId || !['excellent', 'good', 'poor', 'lost'].includes(quality)) return;
    const state = quality === 'poor' || quality === 'lost' ? 'weak' : 'back';
    let target = null;
    if (socket.data?.isHost && socket.data?.streamId) {
        target = { scope: 'stream', streamId: socket.data.streamId };
    } else if (typeof data?.sessionId === 'string') {
        const call = await prisma.videoCallSession.findUnique({
            where: { id: data.sessionId },
            select: { id: true, status: true, callerId: true, creatorId: true },
        });
        if (call?.status === 'ACTIVE' && (call.callerId === userId || call.creatorId === userId)) {
            target = { scope: 'call', sessionId: call.id, other: call.callerId === userId ? call.creatorId : call.callerId };
        }
    }
    if (target) await noticeState(target, userId, state, null);
};

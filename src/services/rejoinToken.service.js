/**
 * BE-14: a fresh LiveKit token for a host or viewer reconnecting to the same room, so a
 * reconnect does not repeat the whole go-live or join (no new stream, no viewer-count bump,
 * no password prompt). GET /api/live-stream/:id/rejoin-token.
 *
 * Who may rejoin:
 *   - the host of a stream that is still live
 *   - a viewer who already joined it through /join (stream:history:<streamId>, which /join
 *     writes only after the password and kick checks) and is not kicked now
 */

/**
 * Pure decision, so it can be tested without Redis or LiveKit.
 * @returns {{ ok: true, role: 'host'|'viewer' } | { ok: false, status: number, code: string, message: string }}
 */
export const decideRejoin = ({ stream, userId, kickTtl, hasJoined }) => {
    if (!stream) return { ok: false, status: 404, code: 'STREAM_NOT_FOUND', message: 'Stream not found' };
    if (!stream.isLive) return { ok: false, status: 404, code: 'STREAM_ENDED', message: 'Stream has ended' };
    if (stream.userId === userId) return { ok: true, role: 'host' };
    if (kickTtl !== null && kickTtl !== undefined) {
        return { ok: false, status: 403, code: 'KICKED', message: 'You have been kicked from this stream' };
    }
    if (!hasJoined) {
        return { ok: false, status: 403, code: 'NOT_JOINED', message: 'Join the stream first' };
    }
    return { ok: true, role: 'viewer' };
};

/**
 * @param deps { getStream, isKicked, hasJoined, hostToken, viewerToken } injected by the controller
 */
export const rejoinTokenService = async ({ id, userId }, deps) => {
    const stream = await deps.getStream(id);
    const isHost = !!stream && stream.userId === userId;
    const [kickTtl, hasJoined] = stream && stream.isLive && !isHost
        ? await Promise.all([deps.isKicked(stream.streamId, userId), deps.hasJoined(stream.streamId, userId)])
        : [null, false];

    const decision = decideRejoin({ stream, userId, kickTtl, hasJoined });
    if (!decision.ok) return decision;

    const token = decision.role === 'host'
        ? await deps.hostToken(stream.streamId, userId)
        : await deps.viewerToken(stream.streamId, userId);
    return { ok: true, role: decision.role, token, streamId: stream.streamId, id: stream.id };
};

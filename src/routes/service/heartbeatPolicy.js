/**
 * What the stream monitor should do about a host's heartbeat (LIVE-19).
 *
 * The app sends the host heartbeat from the live room screen. Minimizing the room, or a dead
 * live socket, stops it while the host keeps publishing in LiveKit, and the monitor used to
 * end those healthy streams after HEARTBEAT_TIMEOUT_MS. LiveKit presence is the stronger
 * signal: while the host is in the room, the stream is alive whatever the app timer does.
 *
 * Pure function so it can be unit-tested without Redis/LiveKit.
 *
 * @param {{ now: number, ageMs: number, lastHeartbeatTime: number|null,
 *           timeoutMs: number, startGraceMs: number, paused: boolean,
 *           hostInLiveKit: boolean }} s
 * @returns {'alive'|'keepalive'|'paused'|'end'}
 *   alive     - heartbeat is recent (or still inside the start grace); nothing to do
 *   keepalive - heartbeat is stale but the host is in the LiveKit room; refresh it, keep the stream
 *   paused    - stale, host not in LiveKit, but on a video call / inside the return grace
 *   end       - stale and the host is gone from LiveKit; end the stream
 */
export const heartbeatVerdict = ({
    now,
    ageMs,
    lastHeartbeatTime,
    timeoutMs,
    startGraceMs,
    paused,
    hostInLiveKit,
}) => {
    if (ageMs < startGraceMs) return 'alive';
    const sinceLastPing = lastHeartbeatTime ? now - lastHeartbeatTime : ageMs;
    if (sinceLastPing <= timeoutMs) return 'alive';
    if (hostInLiveKit) return 'keepalive';
    if (paused) return 'paused';
    return 'end';
};

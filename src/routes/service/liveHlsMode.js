/**
 * Phase 0 HLS check: the shipped app cannot play HLS from the join response.
 * live_room_swiper_screen.dart skips the LiveKit connect when mode is "HLS" but
 * still opens LiveRoomScreen with mode "WEBRTC" and no hlsUrl, so viewer 51+
 * got a black screen. Until the app passes mode/hlsUrl through, every viewer
 * stays on WebRTC. LIVE_HLS_SWITCH=on restores the 51+ switch (and the egress
 * pre-warm at 47) once the app supports it.
 */
export const HLS_VIEWER_THRESHOLD = 50;
export const HLS_PREWARM_AT = 47;

export const hlsSwitchOn = (env = process.env) =>
    String(env.LIVE_HLS_SWITCH || "off").toLowerCase() === "on";

export const viewerPlayback = ({ viewerCount, isHost, streamId, cdnDomain, env = process.env }) => {
    const on = hlsSwitchOn(env);
    const prewarm = on && viewerCount >= HLS_PREWARM_AT;
    if (on && !isHost && viewerCount > HLS_VIEWER_THRESHOLD && cdnDomain) {
        return { mode: "HLS", hlsUrl: `${cdnDomain}/hls/streams/${streamId}/live.m3u8`, prewarm };
    }
    return { mode: "WEBRTC", hlsUrl: null, prewarm };
};

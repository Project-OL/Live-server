import { test } from "node:test";
import assert from "node:assert/strict";
import { viewerPlayback } from "./liveHlsMode.js";

// Phase 0: the shipped app can't play HLS from the join response, so it stays off by default.

const base = { isHost: false, streamId: "s1", cdnDomain: "https://cdn.example" };

test("default keeps every viewer on WebRTC, no egress pre-warm", () => {
    const r = viewerPlayback({ ...base, viewerCount: 500, env: {} });
    assert.deepEqual(r, { mode: "WEBRTC", hlsUrl: null, prewarm: false });
});

test("LIVE_HLS_SWITCH=on switches viewer 51+ to the .m3u8 playlist", () => {
    const env = { LIVE_HLS_SWITCH: "on" };
    assert.equal(viewerPlayback({ ...base, viewerCount: 50, env }).mode, "WEBRTC");
    assert.equal(viewerPlayback({ ...base, viewerCount: 47, env }).prewarm, true);
    const r = viewerPlayback({ ...base, viewerCount: 51, env });
    assert.equal(r.mode, "HLS");
    assert.equal(r.hlsUrl, "https://cdn.example/hls/streams/s1/live.m3u8");
});

test("the host never gets HLS", () => {
    const r = viewerPlayback({ ...base, isHost: true, viewerCount: 200, env: { LIVE_HLS_SWITCH: "on" } });
    assert.equal(r.mode, "WEBRTC");
});

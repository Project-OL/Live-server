import { test } from "node:test";
import assert from "node:assert/strict";
import { livekitHostPublishingVideo } from "./livekitPresence.js";
import { hostNoVideoMs } from "./hostNoVideo.js";

// Phase 0 black-screen gap: host in the room, no video, camera not switched off.

test("livekitHostPublishingVideo reads the host's unmuted video track", async () => {
    const list = (tracks) => async () => [{ identity: "viewer", tracks: [{ type: 1, muted: false }] }, { identity: "host", tracks }];
    assert.equal(await livekitHostPublishingVideo("r", "host", list([{ type: 1, muted: false }])), true);
    assert.equal(await livekitHostPublishingVideo("r", "host", list([{ type: 1, muted: true }])), false, "muted video");
    assert.equal(await livekitHostPublishingVideo("r", "host", list([{ type: 0, muted: false }])), false, "audio only");
    assert.equal(await livekitHostPublishingVideo("r", "host", list([])), false);
    assert.equal(await livekitHostPublishingVideo("r", "nobody", list([])), null, "host not in room");
    assert.equal(await livekitHostPublishingVideo("r", "host", async () => { throw new Error("down"); }), null);
});

const fakeRedis = () => {
    const m = new Map();
    return {
        isOpen: true,
        m,
        get: async (k) => (m.has(k) ? m.get(k) : null),
        set: async (k, v, o) => { if (o?.NX && m.has(k)) return null; m.set(k, v); return "OK"; },
        del: async (k) => { m.delete(k); return 1; },
    };
};

test("hostNoVideoMs times the gap, respects the camera switch and checks every 30 s", async () => {
    const redis = fakeRedis();
    let publishing = false;
    const deps = { publishing: async () => publishing, redis };
    const t0 = 1_000_000;
    assert.equal(await hostNoVideoMs("s1", "h", t0, deps), 0, "first no-video tick starts the clock");
    assert.equal(await hostNoVideoMs("s1", "h", t0 + 10_000, deps), null, "within 30 s: not re-checked");
    assert.equal(await hostNoVideoMs("s1", "h", t0 + 400_000, deps), 400_000);

    redis.m.set("stream:camera_off_at:s1", String(t0));
    assert.equal(await hostNoVideoMs("s1", "h", t0 + 440_000, deps), null, "camera off on purpose");
    assert.equal(redis.m.has("stream:host_novideo_since:s1"), false, "clock reset");

    redis.m.delete("stream:camera_off_at:s1");
    publishing = true;
    assert.equal(await hostNoVideoMs("s1", "h", t0 + 480_000, deps), null, "video back");
});

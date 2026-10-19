import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { HANDLED_EVENTS, payloadProblem, socketEventGuard } from "./eventGuard.js";
import { TokenBuckets, takeToken } from "../utils/tokenBucket.js";
import { restClassOf, restRateAllow } from "../middlewares/restRateLimit.js";

const quiet = () => {
    const saved = { log: console.log, warn: console.warn };
    console.log = () => {};
    console.warn = () => {};
    return () => Object.assign(console, saved);
};

const run = (guard, packet) => {
    let passed = false;
    guard(packet, () => {
        passed = true;
    });
    return passed;
};
const fakeSocket = () => ({ data: { authUserId: "u1" }, handshake: {} });

beforeEach(() => {
    delete process.env.LIVE_RATE_LIMIT_MODE;
    delete process.env.LIVE_SOCKET_GUARD_MODE;
});

test("LIVE-58: handled events without an object payload are always dropped (and acked)", () => {
    const restore = quiet();
    process.env.LIVE_SOCKET_GUARD_MODE = "off";
    process.env.LIVE_RATE_LIMIT_MODE = "off";
    const g = socketEventGuard(fakeSocket());
    for (const payload of [undefined, null, "abc", 5, ["x"]]) {
        assert.equal(run(g, ["join_stream", payload]), false, `payload ${JSON.stringify(payload)}`);
    }
    let acked = null;
    run(g, ["send_gift", null, (r) => (acked = r)]);
    assert.deepEqual(acked, { success: false, code: "INVALID_PAYLOAD" });
    // Events the server doesn't handle are untouched (the app emits several of them).
    assert.equal(run(g, ["host_call_status", "anything"]), true);
    assert.equal(run(g, ["join_stream", { streamId: "s1" }]), true);
    restore();
});

test("every app payload shape passes the field checks", () => {
    const ok = {
        join_stream: { streamId: "a3f1c2d4-0000-4000-8000-000000000000" },
        toggle_camera_state: { streamId: "s", isCameraOn: true },
        toggle_self_mute: { streamId: "s", muteState: false },
        toggle_sheet_mute: { streamId: "s", targetUserId: "u2", muteState: true },
        invite_to_sheet: { streamId: "s", targetUserId: "u2" },
        send_gift: { streamId: "s", giftId: 12, receiverId: "u2", count: 1, comboCount: 3 },
        send_lucky_gift: { streamId: "s", giftId: "g1", comboCount: 1, clientTxId: "tx-1" },
        set_chat_permission: { streamId: "s", mode: "followers" },
        SEND_MESSAGE: { receiverId: "u2", text: "hi" }
    };
    for (const [event, payload] of Object.entries(ok)) assert.equal(payloadProblem(event, payload), null, event);
    assert.ok(HANDLED_EVENTS.has("SEND_MESSAGE"));
});

test("field problems are named", () => {
    assert.equal(payloadProblem("join_stream", {}), "streamId:missing");
    assert.equal(payloadProblem("join_stream", { streamId: { $ne: 1 } }), "streamId:type");
    assert.equal(payloadProblem("toggle_camera_state", { streamId: "s", isCameraOn: "yes" }), "isCameraOn:type");
    assert.equal(payloadProblem("send_gift", { streamId: "s", giftId: 1, count: 0 }), "count:range");
    assert.equal(payloadProblem("SEND_MESSAGE", { receiverId: "u", text: "x".repeat(1001) }), "text:too_long");
    assert.equal(payloadProblem("unknown_event", {}), null);
});

test("log mode passes invalid payloads; enforce drops them", () => {
    const restore = quiet();
    process.env.LIVE_RATE_LIMIT_MODE = "off";
    const g = socketEventGuard(fakeSocket());
    assert.equal(run(g, ["join_stream", {}]), true);
    process.env.LIVE_SOCKET_GUARD_MODE = "enforce";
    assert.equal(run(g, ["join_stream", {}]), false);
    restore();
});

test("socket rate limit: log passes everything, enforce drops past the burst", () => {
    const restore = quiet();
    const g = socketEventGuard(fakeSocket());
    let passed = 0;
    for (let i = 0; i < 30; i++) passed += run(g, ["SEND_MESSAGE", { receiverId: "u2", text: "x" }]);
    assert.equal(passed, 30); // default mode is log
    process.env.LIVE_RATE_LIMIT_MODE = "enforce";
    const g2 = socketEventGuard(fakeSocket());
    passed = 0;
    for (let i = 0; i < 30; i++) passed += run(g2, ["SEND_MESSAGE", { receiverId: "u2", text: "x" }]);
    assert.equal(passed, 10); // chat burst
    restore();
});

test("token buckets refill over time", () => {
    const b = new TokenBuckets({ capacity: 2, refillPerSec: 1 });
    assert.equal(b.take("k", 0), true);
    assert.equal(b.take("k", 0), true);
    assert.equal(b.take("k", 0), false);
    assert.equal(b.take("k", 1000), true);
    b.prune(10_000_000);
    assert.equal(b.size, 0);
    const s = {};
    assert.equal(takeToken(s, 1, 1, 0), true);
    assert.equal(takeToken(s, 1, 1, 500), false);
    assert.equal(takeToken(s, 1, 1, 1000), true);
});

test("REST classes and enforce answer", () => {
    assert.equal(restClassOf("POST", "/api/live-stream/abc/send-gift"), "gift");
    assert.equal(restClassOf("POST", "/api/live-stream/lucky-gift/send"), "gift");
    assert.equal(restClassOf("POST", "/api/live-stream/abc/message"), "chat");
    assert.equal(restClassOf("POST", "/api/live-stream/global-message"), "chat");
    assert.equal(restClassOf("POST", "/api/live-stream/go-live"), "golive");
    assert.equal(restClassOf("GET", "/api/live-stream/abc/messages"), "default");

    const restore = quiet();
    process.env.LIVE_RATE_LIMIT_MODE = "enforce";
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; } };
    const req = { method: "POST", originalUrl: "/api/live-stream/go-live" };
    let allowed = 0;
    for (let i = 0; i < 8; i++) allowed += restRateAllow(req, res, "user-rest-test");
    assert.equal(allowed, 5);
    assert.equal(res.code, 429);
    assert.equal(res.body.code, "RATE_LIMITED");
    assert.equal(res.headers["Retry-After"], "5");
    restore();
});

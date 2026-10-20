import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { AccessToken } from "livekit-server-sdk";

process.env.IS_TEST = "1";
process.env.LIVEKIT_API_KEY = "test-key";
process.env.LIVEKIT_API_SECRET = "test-secret-test-secret-test-secret-0123";

const { livekitWebhook } = await import("./controller.js");

const fakeRes = () => {
    const res = { statusCode: 200, body: undefined };
    res.status = (c) => { res.statusCode = c; return res; };
    res.send = (b) => { res.body = b; return res; };
    return res;
};

const fakeReq = (body, authorization) => ({
    body,
    get: (h) => (h.toLowerCase() === "authorization" ? authorization : undefined),
});

// A participant event touches no DB, so the handler's success path stays offline.
const payload = JSON.stringify({ event: "participant_joined", id: "EV_test", createdAt: "1" });

const sign = async (key, secret, body) => {
    const at = new AccessToken(key, secret);
    at.sha256 = crypto.createHash("sha256").update(body).digest("base64");
    return at.toJwt();
};

test("SEC-07: a correctly signed webhook is accepted", async () => {
    const auth = await sign(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, payload);
    const res = fakeRes();
    await livekitWebhook(fakeReq(Buffer.from(payload), auth), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "OK");
});

test("SEC-07: an unsigned webhook is rejected", async () => {
    const res = fakeRes();
    await livekitWebhook(fakeReq(Buffer.from(payload), undefined), res);
    assert.equal(res.statusCode, 401);
});

test("SEC-07: a webhook signed with another secret is rejected", async () => {
    const auth = await sign(process.env.LIVEKIT_API_KEY, "some-other-secret-some-other-secret-00", payload);
    const res = fakeRes();
    await livekitWebhook(fakeReq(Buffer.from(payload), auth), res);
    assert.equal(res.statusCode, 401);
});

test("SEC-07: a tampered body is rejected", async () => {
    const auth = await sign(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, payload);
    const tampered = payload.replace("participant_joined", "room_finished");
    const res = fakeRes();
    await livekitWebhook(fakeReq(Buffer.from(tampered), auth), res);
    assert.equal(res.statusCode, 401);
});

test("SEC-07: a body already parsed as JSON (not raw) is rejected", async () => {
    const res = fakeRes();
    await livekitWebhook(fakeReq(JSON.parse(payload), "Bearer x"), res);
    assert.equal(res.statusCode, 401);
});

test("LIVE_WEBHOOK_MODE defaults to log (room_finished must not end calls until enforced)", async () => {
    const { webhookMode } = await import("../../services/livekitEvents.service.js");
    const saved = process.env.LIVE_WEBHOOK_MODE;
    delete process.env.LIVE_WEBHOOK_MODE;
    assert.equal(webhookMode(), "log");
    process.env.LIVE_WEBHOOK_MODE = "enforce";
    assert.equal(webhookMode(), "enforce");
    process.env.LIVE_WEBHOOK_MODE = "bogus";
    assert.equal(webhookMode(), "log");
    if (saved === undefined) delete process.env.LIVE_WEBHOOK_MODE; else process.env.LIVE_WEBHOOK_MODE = saved;
});

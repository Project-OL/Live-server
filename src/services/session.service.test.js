import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAccessPayload, sessionKeys } from "./session.service.js";

/** Fake Redis (key → value) and DB rows for checkAccessPayload. */
const deps = ({ redis = {}, userTv = 0, session = null } = {}) => ({
    mget: async (list) => list.map((k) => (k in redis ? redis[k] : null)),
    findUserTokenVersion: async () => userTv,
    findSession: async () => session,
});

const U = "user-1";
const S = "sess-1";
const D = "device-1";
const blob = (over = {}) => JSON.stringify({ userId: U, revoked: false, sessionTokenVersion: 0, ...over });

test("valid token with matching versions passes", async () => {
    const r = await checkAccessPayload(
        { userId: U, tokenVersion: 2, sessionId: S, sessionTokenVersion: 1, deviceId: D },
        deps({ redis: { [sessionKeys.userTokenVersion(U)]: "2", [sessionKeys.session(S)]: blob({ sessionTokenVersion: 1 }), [sessionKeys.deviceBanned(D)]: "0" } })
    );
    assert.deepEqual(r, { ok: true });
});

test("token without a session (legacy/minted) still needs the current token version", async () => {
    assert.equal((await checkAccessPayload({ userId: U }, deps({ userTv: 0 }))).ok, true);
    const r = await checkAccessPayload({ userId: U }, deps({ userTv: 1 }));
    assert.equal(r.code, "SESSION_INVALID");
    assert.equal(r.statusCode, 401);
});

test("token version bumped by a ban / logout-all / password reset is revoked (Redis value)", async () => {
    const r = await checkAccessPayload({ userId: U, tokenVersion: 0 }, deps({ redis: { [sessionKeys.userTokenVersion(U)]: "3" } }));
    assert.equal(r.code, "SESSION_INVALID");
});

test("Redis miss falls back to users.token_version", async () => {
    assert.equal((await checkAccessPayload({ userId: U, tokenVersion: 4 }, deps({ userTv: 4 }))).ok, true);
});

test("revoked session blob is rejected", async () => {
    const r = await checkAccessPayload(
        { userId: U, sessionId: S },
        deps({ redis: { [sessionKeys.session(S)]: blob({ revoked: true }) } })
    );
    assert.equal(r.code, "SESSION_INVALID");
});

test("session belonging to another user is rejected", async () => {
    const r = await checkAccessPayload(
        { userId: U, sessionId: S },
        deps({ redis: { [sessionKeys.session(S)]: blob({ userId: "someone-else" }) } })
    );
    assert.equal(r.code, "SESSION_INVALID");
});

test("stale session token version is rejected as SESSION_TOKEN_STALE", async () => {
    const r = await checkAccessPayload(
        { userId: U, sessionId: S, sessionTokenVersion: 1 },
        deps({ redis: { [sessionKeys.session(S)]: blob({ sessionTokenVersion: 2 }) } })
    );
    assert.equal(r.code, "SESSION_TOKEN_STALE");
});

test("session Redis miss falls back to the sessions row", async () => {
    const ok = await checkAccessPayload(
        { userId: U, sessionId: S, sessionTokenVersion: 5 },
        deps({ session: { userId: U, isRevoked: false, isActive: true, tokenVersion: 5 } })
    );
    assert.equal(ok.ok, true);
    const revoked = await checkAccessPayload(
        { userId: U, sessionId: S, sessionTokenVersion: 5 },
        deps({ session: { userId: U, isRevoked: true, isActive: true, tokenVersion: 5 } })
    );
    assert.equal(revoked.code, "SESSION_INVALID");
    const missing = await checkAccessPayload({ userId: U, sessionId: S }, deps({ session: null }));
    assert.equal(missing.code, "SESSION_INVALID");
});

test("banned device is rejected with 403 DEVICE_BANNED; a cache miss is not a ban", async () => {
    const banned = await checkAccessPayload(
        { userId: U, deviceId: D },
        deps({ redis: { [sessionKeys.deviceBanned(D)]: "1" } })
    );
    assert.equal(banned.code, "DEVICE_BANNED");
    assert.equal(banned.statusCode, 403);
    assert.equal((await checkAccessPayload({ userId: U, deviceId: D }, deps())).ok, true);
});

test("uses the same Redis key names as ol-node-rest", () => {
    assert.equal(sessionKeys.userTokenVersion("u"), "user:u:token_version");
    assert.equal(sessionKeys.session("s"), "session:s");
    assert.equal(sessionKeys.deviceBanned("d"), "device:d:banned");
});

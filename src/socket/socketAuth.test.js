import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
    EXPIRED_GRACE_SEC,
    extractSocketToken,
    socketAuthMiddleware,
    verifySocketToken,
} from "./socketAuth.js";

const SECRET = "test-secret";
// jwt.verify checks `exp` against the real clock, so test times are relative to it.
const NOW = Math.floor(Date.now() / 1000);
const sign = (payload, opts = {}) => jwt.sign({ iat: NOW - 10, ...payload }, SECRET, { noTimestamp: true, ...opts });

beforeEach(() => {
    process.env.JWT_ACCESS_SECRET = SECRET;
    delete process.env.LIVE_SOCKET_AUTH_MODE;
});

test("finds the token in auth, header or query, with or without Bearer", () => {
    assert.equal(extractSocketToken({ auth: { token: "Bearer abc" } }), "abc");
    assert.equal(extractSocketToken({ headers: { authorization: "Bearer def" } }), "def");
    assert.equal(extractSocketToken({ query: { token: "ghi" } }), "ghi");
    assert.equal(extractSocketToken({}), "");
});

test("valid token gives its userId", () => {
    const t = sign({ userId: "u1", exp: NOW + 3600 });
    assert.deepEqual(verifySocketToken({ auth: { token: `Bearer ${t}` } }, SECRET, NOW), { outcome: "ok", userId: "u1" });
});

test("expired token with a valid signature is accepted within the grace", () => {
    const t = sign({ userId: "u1", exp: NOW - 3600 });
    assert.deepEqual(verifySocketToken({ auth: { token: t } }, SECRET, NOW), { outcome: "expired_ok", userId: "u1" });
});

test("token expired beyond the grace is rejected", () => {
    const t = sign({ userId: "u1", exp: NOW - EXPIRED_GRACE_SEC - 10 });
    assert.equal(verifySocketToken({ auth: { token: t } }, SECRET, NOW).outcome, "expired_too_old");
});

test("forged token is invalid", () => {
    const t = jwt.sign({ userId: "u1" }, "other-secret");
    assert.equal(verifySocketToken({ auth: { token: t } }, SECRET, NOW).outcome, "invalid");
});

const run = (handshake) => {
    const socket = { handshake, data: {} };
    let err = "not-called";
    socketAuthMiddleware(socket, (e) => { err = e; });
    return { socket, err };
};

test("log mode never rejects and keeps the claimed userId", () => {
    const t = jwt.sign({ userId: "real" }, SECRET, { expiresIn: 3600 });
    const { socket, err } = run({ auth: { token: t, userId: "claimed" }, query: { userId: "claimed" } });
    assert.equal(err, undefined);
    assert.equal(socket.handshake.query.userId, "claimed");
    assert.equal(socket.data.authUserId, "real");
});

test("log mode lets a socket without a token through", () => {
    const { err } = run({ query: { userId: "x" } });
    assert.equal(err, undefined);
});

test("enforce mode rejects a socket without a valid token", () => {
    process.env.LIVE_SOCKET_AUTH_MODE = "enforce";
    const { err } = run({ query: { userId: "x" } });
    assert.ok(err instanceof Error);
    assert.equal(err.data.code, "SOCKET_UNAUTHORIZED");
});

test("enforce mode replaces the claimed userId with the token's", () => {
    process.env.LIVE_SOCKET_AUTH_MODE = "enforce";
    const t = jwt.sign({ userId: "real" }, SECRET, { expiresIn: 3600 });
    const { socket, err } = run({ auth: { token: t, userId: "victim" }, query: { userId: "victim" } });
    assert.equal(err, undefined);
    assert.equal(socket.handshake.auth.userId, "real");
    assert.equal(socket.handshake.query.userId, "real");
});

test("off mode does nothing", () => {
    process.env.LIVE_SOCKET_AUTH_MODE = "off";
    const { socket, err } = run({ query: { userId: "x" } });
    assert.equal(err, undefined);
    assert.equal(socket.data.authUserId, undefined);
});

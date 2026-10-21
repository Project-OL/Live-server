import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { verifyRotating } from "./jwtRotation.js";
import { verifySocketToken } from "../socket/socketAuth.js";

// SEC-01: rotate the shared JWT secrets without logging anyone out.
const CURRENT = "c".repeat(48);
const PREVIOUS = "p".repeat(48);
const OTHER = "o".repeat(48);
const now = Math.floor(Date.now() / 1000);

test("current and previous secrets verify; any other secret does not", () => {
    assert.equal(verifyRotating(jwt.sign({ userId: "a" }, CURRENT), CURRENT, PREVIOUS).userId, "a");
    assert.equal(verifyRotating(jwt.sign({ userId: "b" }, PREVIOUS), CURRENT, PREVIOUS).userId, "b");
    assert.throws(() => verifyRotating(jwt.sign({ userId: "x" }, OTHER), CURRENT, PREVIOUS), /invalid signature/);
});

test("without a previous secret an old token is rejected (after the grace period)", () => {
    assert.throws(() => verifyRotating(jwt.sign({ userId: "b" }, PREVIOUS), CURRENT, undefined), /invalid signature/);
});

test("expiry is reported as expiry for tokens of either secret", () => {
    for (const s of [CURRENT, PREVIOUS]) {
        const t = jwt.sign({ userId: "e", exp: now - 60 }, s);
        assert.throws(() => verifyRotating(t, CURRENT, PREVIOUS), jwt.TokenExpiredError);
    }
});

test("socket handshake: a previous-secret token is accepted during the grace, expired ones keep the 30-day grace", () => {
    const fresh = jwt.sign({ userId: "u1" }, PREVIOUS, { expiresIn: "1h" });
    assert.deepEqual(verifySocketToken({ auth: { token: fresh } }, CURRENT, now, PREVIOUS), { outcome: "ok", userId: "u1" });

    const expired = jwt.sign({ userId: "u2", exp: now - 3600 }, PREVIOUS);
    assert.deepEqual(verifySocketToken({ auth: { token: expired } }, CURRENT, now, PREVIOUS), { outcome: "expired_ok", userId: "u2" });

    assert.deepEqual(verifySocketToken({ auth: { token: fresh } }, CURRENT, now, undefined), { outcome: "invalid", userId: null });
});

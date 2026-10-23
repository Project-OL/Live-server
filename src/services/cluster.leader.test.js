import { test } from "node:test";
import assert from "node:assert/strict";
import { isLeader } from "./cluster.service.js";

// F11: with Redis unreachable (the test process never connects it) no node leads.
test("F11: Redis down -> no node runs the singleton loops", async () => {
    delete process.env.LIVE_LEADER_REDIS_DOWN;
    assert.equal(await isLeader("f11-test"), false);
});

test("F11: LIVE_LEADER_REDIS_DOWN=local restores the old run-here fallback", async () => {
    process.env.LIVE_LEADER_REDIS_DOWN = "local";
    try {
        assert.equal(await isLeader("f11-test"), true);
    } finally {
        delete process.env.LIVE_LEADER_REDIS_DOWN;
    }
});

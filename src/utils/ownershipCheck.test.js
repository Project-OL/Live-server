import { test } from "node:test";
import assert from "node:assert/strict";
import { ownershipCheckMode, rejectNotOwner } from "./ownershipCheck.js";

const withMode = (mode, fn) => {
    const saved = process.env.LIVE_OWNERSHIP_CHECK_MODE;
    if (mode === undefined) delete process.env.LIVE_OWNERSHIP_CHECK_MODE;
    else process.env.LIVE_OWNERSHIP_CHECK_MODE = mode;
    try { return fn(); } finally {
        if (saved === undefined) delete process.env.LIVE_OWNERSHIP_CHECK_MODE;
        else process.env.LIVE_OWNERSHIP_CHECK_MODE = saved;
    }
};

test("defaults to log mode, which never rejects", () => {
    withMode(undefined, () => {
        assert.equal(ownershipCheckMode(), "log");
        assert.equal(rejectNotOwner("test_kind", "detail"), false);
    });
});

test("unknown values fall back to log", () => {
    withMode("ENFORCE-ish", () => assert.equal(ownershipCheckMode(), "log"));
});

test("enforce mode rejects", () => {
    withMode(" Enforce ", () => {
        assert.equal(ownershipCheckMode(), "enforce");
        assert.equal(rejectNotOwner("test_kind", "detail"), true);
    });
});

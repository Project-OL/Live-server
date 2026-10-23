import { test } from "node:test";
import assert from "node:assert/strict";
import { callerCoinsPerMinute } from "./callRate.service.js";

test("F10: default share gives exactly the old ceil(price * 5 / 3)", () => {
    for (const price of [1800, 3600, 5400, 1, 2, 3, 1234, 99999]) {
        assert.equal(callerCoinsPerMinute(price), BigInt(Math.ceil((price * 5) / 3)), String(price));
    }
});

test("F10: follows the admin share like the ledger (ceiling division)", () => {
    assert.equal(callerCoinsPerMinute(1800, 5000), 3600n);
    assert.equal(callerCoinsPerMinute(1800, 7000), 2572n); // ceil(18000000 / 7000) = 2571.43 -> 2572
    assert.equal(callerCoinsPerMinute(0, 6000), 0n);
});

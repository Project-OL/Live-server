import { test } from "node:test";
import assert from "node:assert/strict";
import { livekitHostIsPresent } from "./livekitPresence.js";

// LIVE-43: the sweep's presence source. `deps` replaces the LiveKit API and the webhook record.
const deps = (mode, { api, webhook }) => {
    const calls = { api: 0, webhook: 0 };
    return {
        calls,
        mode: () => mode,
        api: async () => {
            calls.api += 1;
            if (api instanceof Error) throw api;
            return api;
        },
        webhook: async () => {
            calls.webhook += 1;
            if (webhook instanceof Error) throw webhook;
            return webhook;
        }
    };
};

test("off: only the LiveKit API is asked (the pre-LIVE-43 behaviour)", async () => {
    const d = deps("off", { api: true, webhook: false });
    assert.equal(await livekitHostIsPresent("room", "host", d), true);
    assert.deepEqual(d.calls, { api: 1, webhook: 0 });
});

test("log (default): the API answer wins even when webhooks disagree", async () => {
    for (const [api, webhook] of [[true, false], [false, true], [true, true], [false, null]]) {
        const d = deps("log", { api, webhook });
        assert.equal(await livekitHostIsPresent("room", "host", d), api);
        assert.deepEqual(d.calls, { api: 1, webhook: 1 });
    }
});

test("log: a failing webhook read never changes the answer", async () => {
    const d = deps("log", { api: true, webhook: new Error("redis down") });
    assert.equal(await livekitHostIsPresent("room", "host", d), true);
});

test("enforce: the webhook record is used and LiveKit is not called", async () => {
    for (const webhook of [true, false]) {
        const d = deps("enforce", { api: !webhook, webhook });
        assert.equal(await livekitHostIsPresent("room", "host", d), webhook);
        assert.equal(d.calls.api, 0);
    }
});

test("enforce: no webhook record (or a failed read) falls back to the API", async () => {
    for (const webhook of [null, new Error("redis down")]) {
        const d = deps("enforce", { api: true, webhook });
        assert.equal(await livekitHostIsPresent("room", "host", d), true);
        assert.equal(d.calls.api, 1);
    }
});

test("missing room or host is absent without asking anyone", async () => {
    const d = deps("log", { api: true, webhook: true });
    assert.equal(await livekitHostIsPresent("", "host", d), false);
    assert.equal(await livekitHostIsPresent("room", null, d), false);
    assert.deepEqual(d.calls, { api: 0, webhook: 0 });
});

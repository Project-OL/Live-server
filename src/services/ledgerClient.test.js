import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { callLedger, signRequest, toLocalError, LedgerError, ATTEMPT_TIMEOUT_MS, TOTAL_BUDGET_MS } from "./ledgerClient.js";

const SECRET = "test-internal-ledger-secret-at-least-32-chars";

const withEnv = async (vars, fn) => {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        return await fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
};

const jsonResponse = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test("signature matches ol-node-rest's scheme (HMAC-SHA256 over ts.METHOD.path.body)", () => {
    const sig = signRequest(SECRET, { timestamp: "1700000000000", method: "post", path: "/internal/v1/ledger/gift", body: "{}" });
    const expected = crypto.createHmac("sha256", SECRET).update("1700000000000.POST./internal/v1/ledger/gift.{}").digest("hex");
    assert.equal(sig, `v1=${expected}`);
});

test("retries a timeout / 503 with the same requestId and a fresh signature", async () => {
    await withEnv({ INTERNAL_LEDGER_HMAC_SECRET: SECRET, LIVE_LEDGER_BASE_URL: "http://ledger.test" }, async () => {
        const seen = [];
        let n = 0;
        const fetchImpl = async (url, init) => {
            seen.push({ url, body: JSON.parse(init.body), headers: init.headers });
            n += 1;
            if (n === 1) throw new Error("socket hang up");
            if (n === 2) return jsonResponse(503, {});
            return jsonResponse(200, { ok: true, replayed: true });
        };
        const r = await callLedger("GIFT_LIVE", "gift", { senderId: "s" }, { fetchImpl });
        assert.deepEqual(r, { ok: true, replayed: true });
        assert.equal(seen.length, 3);
        assert.equal(seen[0].url, "http://ledger.test/internal/v1/ledger/gift");
        assert.equal(new Set(seen.map((s) => s.body.requestId)).size, 1, "one requestId across retries");
        for (const s of seen) {
            const expected = signRequest(SECRET, {
                timestamp: s.headers["x-ol-timestamp"],
                method: "POST",
                path: "/internal/v1/ledger/gift",
                body: JSON.stringify(s.body)
            });
            assert.equal(s.headers["x-ol-signature"], expected);
        }
    });
});

test("F03: one attempt outlasts the ledger's 15 s transaction, and all attempts fit the app's 20 s timeout", () => {
    assert.ok(ATTEMPT_TIMEOUT_MS >= 15_000 + 2_000, `attempt ${ATTEMPT_TIMEOUT_MS} ms`);
    assert.ok(TOTAL_BUDGET_MS < 20_000 && TOTAL_BUDGET_MS >= ATTEMPT_TIMEOUT_MS, `budget ${TOTAL_BUDGET_MS} ms`);
});

test("F03: a response slower than the old 3 s attempt is waited for, not re-sent", async () => {
    await withEnv({ INTERNAL_LEDGER_HMAC_SECRET: SECRET }, async () => {
        let calls = 0;
        const fetchImpl = async () => {
            calls += 1;
            await new Promise((r) => setTimeout(r, 3_300));
            return jsonResponse(200, { ok: true });
        };
        const r = await callLedger("GIFT_LIVE", "gift", {}, { fetchImpl, clientTxId: null });
        assert.deepEqual(r, { ok: true });
        assert.equal(calls, 1);
    });
});

test("F03: retries stop at the total budget, and a timed-out give-up logs the requestId", async () => {
    await withEnv({ INTERNAL_LEDGER_HMAC_SECRET: SECRET }, async () => {
        const bodies = [];
        // Hangs until aborted, like a ledger stuck on a lock.
        const fetchImpl = (url, init) => new Promise((_, reject) => {
            bodies.push(JSON.parse(init.body));
            init.signal.addEventListener("abort", () => reject(init.signal.reason));
        });
        const logged = [];
        const orig = console.error;
        console.error = (m) => logged.push(String(m));
        const started = Date.now();
        // AbortSignal.timeout's timer is unref'd; a real socket would keep the loop alive.
        const keepAlive = setInterval(() => {}, 1_000);
        try {
            await assert.rejects(
                callLedger("GIFT_LIVE", "gift", {}, { fetchImpl, attemptTimeoutMs: 1_200, budgetMs: 1_500 }),
                (err) => err instanceof LedgerError && err.code === "LEDGER_UNAVAILABLE"
            );
        } finally {
            clearInterval(keepAlive);
            console.error = orig;
        }
        const took = Date.now() - started;
        assert.ok(took < 2_500, `gave up after ${took} ms`);
        assert.equal(bodies.length, 1, "no attempt started with less than 1 s left");
        assert.ok(logged.some((l) => l.includes("outcome unknown") && l.includes(`requestId=${bodies[0].requestId}`)), logged.join("\n"));
    });
});

test("a 4xx is final (no retry) and keeps the API code", async () => {
    await withEnv({ INTERNAL_LEDGER_HMAC_SECRET: SECRET }, async () => {
        let calls = 0;
        const fetchImpl = async () => {
            calls += 1;
            return jsonResponse(402, { code: "INSUFFICIENT_COINS", message: "Insufficient coins", details: { required: "100", balance: "5" } });
        };
        await assert.rejects(callLedger("GIFT_LIVE", "gift", {}, { fetchImpl }), (err) => {
            assert.ok(err instanceof LedgerError);
            assert.equal(err.code, "INSUFFICIENT_COINS");
            assert.equal(err.status, 402);
            return true;
        });
        assert.equal(calls, 1);
    });
});

test("errors map to the local path's messages, so controllers answer the app as before", () => {
    const insufficient = toLocalError(new LedgerError("x", { code: "INSUFFICIENT_COINS", details: { required: "9", balance: "1" } }), {
        insufficient: (d) => `Insufficient coin balance. Required: ${d.required}, Available: ${d.balance}`
    });
    assert.equal(insufficient.message, "Insufficient coin balance. Required: 9, Available: 1");
    assert.match(toLocalError(new LedgerError("x", { code: "PERSONAL_COINS_FROZEN" }), { insufficient: "" }).message, /frozen/);
    const dup = toLocalError(new LedgerError("x", { code: "DUPLICATE_LEDGER_KEY" }), { insufficient: "" });
    assert.equal(dup.code, "P2002");
    const other = new Error("plain");
    assert.equal(toLocalError(other, { insufficient: "" }), other);
});

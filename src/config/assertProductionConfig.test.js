import { test } from "node:test";
import assert from "node:assert/strict";
import { productionConfigProblems } from "./assertProductionConfig.js";

const good = { LIVEKIT_API_KEY: "APIabc", LIVEKIT_API_SECRET: "s".repeat(40), JWT_ACCESS_SECRET: "j".repeat(64), DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x", INTERNAL_LEDGER_HMAC_SECRET: "l".repeat(48), CORS_ORIGINS: "https://admin.example.com" };

test("F15: production refuses a \"*\" or empty CORS origin list, from any of the four variables", () => {
    assert.equal(productionConfigProblems({ ...good, CORS_ORIGINS: undefined }).length, 1);
    assert.match(productionConfigProblems({ ...good, CORS_ORIGINS: undefined })[0], /CORS_ORIGINS is missing/);
    assert.match(productionConfigProblems({ ...good, CLIENT_URL: "*" })[0], /"\*"/);
    assert.match(productionConfigProblems({ ...good, CORS_ORIGINS: "https://a.example.com, *" })[0], /"\*"/);
    assert.deepEqual(productionConfigProblems({ ...good, CORS_ORIGINS: undefined, CLIENT_URL: "https://a.example.com,https://b.example.com" }), []);
});

test("BE-20: production refuses to boot without the ledger key (the only money path since 2026-10-21)", () => {
    assert.deepEqual(productionConfigProblems({ ...good, INTERNAL_LEDGER_HMAC_SECRET: undefined }), ["INTERNAL_LEDGER_HMAC_SECRET is missing"]);
    assert.deepEqual(productionConfigProblems({ ...good, INTERNAL_LEDGER_HMAC_SECRET: "changeme" }), ["INTERNAL_LEDGER_HMAC_SECRET is a placeholder"]);
});

test("LIVE-45: a complete production config has no problems", () => {
    assert.deepEqual(productionConfigProblems(good), []);
    assert.deepEqual(productionConfigProblems({ ...good, JWT_ACCESS_SECRET: undefined, JWT_SECRET: "j".repeat(64) }), []);
});

test("LIVE-45: placeholders and missing values are reported", () => {
    const p = productionConfigProblems({ ...good, LIVEKIT_API_KEY: "devkey", LIVEKIT_API_SECRET: "secret", JWT_ACCESS_SECRET: "fallback_secret", REDIS_URL: "" });
    assert.equal(p.length, 4);
    assert.ok(p.some((x) => x.startsWith("LIVEKIT_API_KEY is a placeholder")));
    assert.ok(p.some((x) => x.startsWith("REDIS_URL is missing")));
});

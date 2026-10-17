import { test } from "node:test";
import assert from "node:assert/strict";
import { productionConfigProblems } from "./assertProductionConfig.js";

const good = { LIVEKIT_API_KEY: "APIabc", LIVEKIT_API_SECRET: "s".repeat(40), JWT_ACCESS_SECRET: "j".repeat(64), DATABASE_URL: "postgresql://x", REDIS_URL: "redis://x" };

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

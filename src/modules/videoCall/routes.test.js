import { test } from "node:test";
import assert from "node:assert/strict";

// Keep the video-call billing sweep (service.js) from starting during the import.
process.env.IS_TEST = "1";

const TEST_PATHS = ["/test-users", "/reset"];
let importCount = 0;

/** Import routes.js fresh with the given env, and return the registered paths. */
const registeredPaths = async (env) => {
    const saved = { NODE_ENV: process.env.NODE_ENV, LIVE_ENABLE_TEST_ROUTES: process.env.LIVE_ENABLE_TEST_ROUTES };
    Object.assign(process.env, env);
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    try {
        const mod = await import(`./routes.js?case=${importCount++}`);
        return mod.default.stack.filter((l) => l.route).map((l) => l.route.path);
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
};

test("SEC-06: test routes are never registered in production, even with the flag", async () => {
    const paths = await registeredPaths({ NODE_ENV: "production", LIVE_ENABLE_TEST_ROUTES: "true" });
    for (const p of TEST_PATHS) assert.ok(!paths.includes(p), `${p} must not exist in production`);
    assert.ok(paths.includes("/initiate"), "normal routes still registered");
});

test("SEC-06: test routes are off by default outside production", async () => {
    const paths = await registeredPaths({ NODE_ENV: "development", LIVE_ENABLE_TEST_ROUTES: undefined });
    for (const p of TEST_PATHS) assert.ok(!paths.includes(p), `${p} must be opt-in`);
});

test("SEC-06: LIVE_ENABLE_TEST_ROUTES=true enables them outside production", async () => {
    const paths = await registeredPaths({ NODE_ENV: "development", LIVE_ENABLE_TEST_ROUTES: "true" });
    for (const p of TEST_PATHS) assert.ok(paths.includes(p), `${p} should be enabled for local testing`);
});

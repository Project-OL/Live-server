import { monitorEventLoopDelay } from "perf_hooks";
import { readFileSync } from "fs";
import prisma from "../config/prisma.js";
import { client as redisClient } from "../config/redis.js";

/**
 * LIVE-46 / INF-12: GET /live-health (the GCP URL map already routes this path to Live-server).
 * 200 when Redis and Postgres answer within 2 s, 503 otherwise; no auth, no user data.
 */
// Phase 0 versioning: the deploy writes release.json ({"commit": "<sha>"}) into the app dir.
const releaseCommit = (() => {
    try {
        const j = JSON.parse(readFileSync(new URL("../../release.json", import.meta.url), "utf8"));
        return typeof j.commit === "string" && j.commit ? j.commit : null;
    } catch {
        return process.env.RELEASE_COMMIT || null;
    }
})();

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

const within = (p, ms) =>
    Promise.race([p.then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), ms).unref?.())]);

export const liveHealth = async (_req, res) => {
    const started = Date.now();
    const [redis, db] = await Promise.all([
        redisClient.isOpen ? within(redisClient.ping(), 2000) : Promise.resolve(false),
        within(prisma.$queryRaw`SELECT 1`, 2000)
    ]);
    const lagMs = Math.round(loopDelay.percentile(99) / 1e6);
    loopDelay.reset();
    const ok = redis && db;
    res.status(ok ? 200 : 503).json({
        status: ok ? "ok" : "degraded",
        redis,
        db,
        eventLoopLagP99Ms: lagMs,
        uptimeSec: Math.round(process.uptime()),
        checkMs: Date.now() - started,
        commit: releaseCommit
    });
};

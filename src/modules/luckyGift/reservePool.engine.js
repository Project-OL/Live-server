import prisma from '../../config/prisma.js';
import { client as redisClient } from '../../config/redis.js';
import { LUCKY_GIFT_CONFIG } from '../../config/luckyGift.config.js';

const SPENT_KEY = "lucky:reserve:total_spent";
const REWARDED_KEY = "lucky:reserve:total_rewarded";
const POOL_KEY = "lucky:reserve:pool_balance";

/**
 * These three counters live only in Redis and they feed `currentRtp`, which
 * sizes every lucky reward. Losing them silently re-baselines payout odds to
 * the configured target RTP, so they are snapshotted to Postgres periodically
 * and can be replayed from `giftTransaction` + PLATFORM_REWARD ledger rows.
 *
 * TODO(phase 2): promote these to a `lucky_reserve_pool` table incremented
 * inside the gift transaction, with Redis demoted to a read cache. That needs a
 * migration on the Postgres shared with ol-node-rest, which owns the migration
 * history, so it ships as its own change.
 */
const SNAPSHOT_ACTION_TYPE = "LUCKY_RESERVE_POOL_SNAPSHOT";
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

const ensureRedis = async () => {
    if (!redisClient.isOpen) {
        try {
            await redisClient.connect();
        } catch (e) {}
    }
};

/**
 * Retrieves current Reserve Pool Statistics from Redis
 */
export const getReservePoolStats = async () => {
    await ensureRedis();

    let spentStr = null;
    let rewardedStr = null;
    let poolStr = null;

    if (redisClient.isOpen) {
        try {
            [spentStr, rewardedStr, poolStr] = await Promise.all([
                redisClient.get(SPENT_KEY),
                redisClient.get(REWARDED_KEY),
                redisClient.get(POOL_KEY)
            ]);
        } catch (e) {
            console.error("[ReservePool Engine] Redis read error:", e.message);
        }
    }

    const totalSpent = spentStr !== null ? Number(spentStr) : 0;
    const totalRewarded = rewardedStr !== null ? Number(rewardedStr) : 0;
    const poolBalance = poolStr !== null ? Number(poolStr) : 0;

    const targetRtp = LUCKY_GIFT_CONFIG.targetRtpPercent || 92.0;
    const currentRtp = totalSpent > 0 
        ? (totalRewarded / totalSpent) * 100 
        : targetRtp;

    return {
        totalSpent,
        totalRewarded,
        poolBalance,
        currentRtp,
        targetRtp
    };
};

/**
 * Updates Reserve Pool Inflow and Outflow atomically
 */
export const updateReservePool = async ({ giftCost, rewardCoins }) => {
    await ensureRedis();

    const cost = Number(giftCost);
    const reward = Number(rewardCoins);
    const targetRtp = (LUCKY_GIFT_CONFIG.targetRtpPercent || 92.0) / 100;

    const inflow = cost * targetRtp;
    const outflow = reward;
    const netPoolChange = inflow - outflow;

    if (!redisClient.isOpen) {
        // Refusing silently would let draws keep paying out against a frozen
        // RTP. The caller logs this against the gift transaction id.
        throw new Error("Reserve pool unavailable: Redis is not connected");
    }

    await Promise.all([
        redisClient.incrBy(SPENT_KEY, Math.round(cost)),
        redisClient.incrBy(REWARDED_KEY, Math.round(reward)),
        redisClient.incrByFloat(POOL_KEY, netPoolChange)
    ]);

    return { inflow, outflow, netPoolChange };
};

/**
 * Append the current counters to `audit_logs` so the pool can be restored after
 * a Redis flush or failover instead of silently resetting to target RTP.
 */
export const snapshotReservePool = async () => {
    const stats = await getReservePoolStats();

    await prisma.auditLog.create({
        data: {
            actionType: SNAPSHOT_ACTION_TYPE,
            actionStatus: "OK",
            actionDetails: {
                totalSpent: stats.totalSpent,
                totalRewarded: stats.totalRewarded,
                poolBalance: stats.poolBalance,
                currentRtp: stats.currentRtp,
                targetRtp: stats.targetRtp,
                snapshotAt: new Date().toISOString()
            }
        }
    });

    return stats;
};

/** Most recent persisted snapshot, or null if none has been taken yet. */
export const getLatestReservePoolSnapshot = async () => {
    const row = await prisma.auditLog.findFirst({
        where: { actionType: SNAPSHOT_ACTION_TYPE },
        orderBy: { createdAt: "desc" }
    });
    return row ? { takenAt: row.createdAt, ...row.actionDetails } : null;
};

/**
 * Restore the Redis counters from the newest snapshot. Only fills keys that are
 * missing, so a live pool is never overwritten by a stale snapshot.
 */
export const restoreReservePoolFromSnapshot = async () => {
    await ensureRedis();
    if (!redisClient.isOpen) return null;

    const [spent, rewarded, pool] = await Promise.all([
        redisClient.get(SPENT_KEY),
        redisClient.get(REWARDED_KEY),
        redisClient.get(POOL_KEY)
    ]);
    if (spent !== null || rewarded !== null || pool !== null) return null;

    const snapshot = await getLatestReservePoolSnapshot();
    if (!snapshot) return null;

    await Promise.all([
        redisClient.set(SPENT_KEY, String(Math.round(snapshot.totalSpent ?? 0)), { NX: true }),
        redisClient.set(REWARDED_KEY, String(Math.round(snapshot.totalRewarded ?? 0)), { NX: true }),
        redisClient.set(POOL_KEY, String(snapshot.poolBalance ?? 0), { NX: true })
    ]);

    console.log(
        `[ReservePool Engine] Restored counters from snapshot taken ${snapshot.takenAt?.toISOString?.() ?? snapshot.snapshotAt}`
    );
    return snapshot;
};

if (process.env.NODE_ENV !== "test" && !process.env.IS_TEST) {
    restoreReservePoolFromSnapshot().catch((e) =>
        console.error("[ReservePool Engine] Restore failed:", e.message)
    );

    setInterval(() => {
        snapshotReservePool().catch((e) =>
            console.error("[ReservePool Engine] Snapshot failed:", e.message)
        );
    }, SNAPSHOT_INTERVAL_MS).unref?.();
}

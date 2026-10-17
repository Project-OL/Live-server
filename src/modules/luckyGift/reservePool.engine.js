import prisma from '../../config/prisma.js';
import { client as redisClient } from '../../config/redis.js';
import { getLuckyShares } from '../../services/luckyShares.service.js';

/**
 * Lucky-gift reserve pool: the running totals that steer every lucky draw toward the RTP target.
 *
 * LIVE-31: the counters live in Postgres (`lucky_reserve_pool`, owned by ol-node-rest's migrations),
 * 8 slots summed on read so concurrent lucky gifts don't queue on one row lock. Each lucky gift adds
 * to a random slot INSIDE its own transaction: ol-node-rest's internal ledger does it in remote
 * mode, `addToReservePoolInTx` below in local mode. A restart or a Redis failover no longer loses
 * history (Redis had no persistence and was only snapshotted every 5 minutes).
 *
 * The Redis keys below are the pre-LIVE-31 counters. They are read once to seed slot 0 (atomic,
 * flagged `seeded`), and as a fallback if the DB read fails; they are no longer written.
 */
const SPENT_KEY = "lucky:reserve:total_spent";
const REWARDED_KEY = "lucky:reserve:total_rewarded";
const POOL_KEY = "lucky:reserve:pool_balance";
const SNAPSHOT_ACTION_TYPE = "LUCKY_RESERVE_POOL_SNAPSHOT";

export const RESERVE_POOL_SLOTS = 8;

const readRedisCounters = async () => {
    if (!redisClient.isOpen) return null;
    try {
        const [s, r, p] = await Promise.all([redisClient.get(SPENT_KEY), redisClient.get(REWARDED_KEY), redisClient.get(POOL_KEY)]);
        if (s === null && r === null && p === null) return null;
        return { totalSpent: Number(s ?? 0), totalRewarded: Number(r ?? 0), poolBalance: Number(p ?? 0) };
    } catch {
        return null;
    }
};

/** Most recent persisted Redis-era snapshot (audit_logs), or null. */
export const getLatestReservePoolSnapshot = async () => {
    const row = await prisma.auditLog.findFirst({
        where: { actionType: SNAPSHOT_ACTION_TYPE },
        orderBy: { createdAt: "desc" }
    });
    return row ? { takenAt: row.createdAt, ...row.actionDetails } : null;
};

/**
 * One time, on whichever node gets there first: add the Redis-era totals (or the last snapshot)
 * to slot 0 and mark it seeded. The `seeded = false` guard makes it happen exactly once.
 */
let seedChecked = false;
const ensureSeeded = async () => {
    if (seedChecked) return;
    const [slot0] = await prisma.$queryRaw`SELECT seeded FROM lucky_reserve_pool WHERE slot = 0`;
    if (slot0?.seeded) {
        seedChecked = true;
        return;
    }
    const legacy = (await readRedisCounters()) || (await getLatestReservePoolSnapshot().catch(() => null)) || {
        totalSpent: 0, totalRewarded: 0, poolBalance: 0
    };
    const spent = BigInt(Math.round(Number(legacy.totalSpent ?? 0)));
    const rewarded = BigInt(Math.round(Number(legacy.totalRewarded ?? 0)));
    const pool = Number(legacy.poolBalance ?? 0);
    await prisma.$executeRaw`
        INSERT INTO lucky_reserve_pool (slot, total_spent, total_rewarded, pool_balance, seeded, updated_at)
        VALUES (0, ${spent}, ${rewarded}, ${pool}, true, NOW())
        ON CONFLICT (slot) DO UPDATE
        SET total_spent = lucky_reserve_pool.total_spent + EXCLUDED.total_spent,
            total_rewarded = lucky_reserve_pool.total_rewarded + EXCLUDED.total_rewarded,
            pool_balance = lucky_reserve_pool.pool_balance + EXCLUDED.pool_balance,
            seeded = true,
            updated_at = NOW()
        WHERE lucky_reserve_pool.seeded = false
    `;
    console.log(`[ReservePool] seeded from the Redis-era counters (spent=${spent}, rewarded=${rewarded}, pool=${pool})`);
    seedChecked = true;
};

/** Current pool statistics and the RTP target (admin setting). */
export const getReservePoolStats = async () => {
    const targetRtp = (await getLuckyShares()).luckyTargetRtpBp / 100;
    let totals = null;
    try {
        await ensureSeeded();
        const [row] = await prisma.$queryRaw`
            SELECT COALESCE(SUM(total_spent), 0)::bigint AS spent,
                   COALESCE(SUM(total_rewarded), 0)::bigint AS rewarded,
                   COALESCE(SUM(pool_balance), 0)::float8 AS pool
            FROM lucky_reserve_pool`;
        totals = { totalSpent: Number(row.spent), totalRewarded: Number(row.rewarded), poolBalance: Number(row.pool) };
    } catch (e) {
        console.error("[ReservePool] DB read failed, using the Redis-era counters:", e.message);
        totals = (await readRedisCounters()) || { totalSpent: 0, totalRewarded: 0, poolBalance: 0 };
    }
    const currentRtp = totals.totalSpent > 0 ? (totals.totalRewarded / totals.totalSpent) * 100 : targetRtp;
    return { ...totals, currentRtp, targetRtp };
};

/**
 * Local-mode lucky gifts: add this gift to the counters inside its money transaction.
 * Inflow = cost x RTP target; outflow = the reward. Upsert, so a DB without the seeded slot rows
 * (tests built with `prisma db push`) still counts.
 */
export const addToReservePoolInTx = async (tx, { giftCost, rewardCoins, targetRtpBp }) => {
    const slot = Math.floor(Math.random() * RESERVE_POOL_SLOTS);
    const cost = BigInt(giftCost);
    const reward = BigInt(rewardCoins);
    await tx.$executeRaw`
        INSERT INTO lucky_reserve_pool (slot, total_spent, total_rewarded, pool_balance, updated_at)
        VALUES (${slot}, ${cost}, ${reward}, (${cost}::numeric * ${targetRtpBp} / 10000) - ${reward}, NOW())
        ON CONFLICT (slot) DO UPDATE
        SET total_spent = lucky_reserve_pool.total_spent + EXCLUDED.total_spent,
            total_rewarded = lucky_reserve_pool.total_rewarded + EXCLUDED.total_rewarded,
            pool_balance = lucky_reserve_pool.pool_balance + EXCLUDED.pool_balance,
            updated_at = NOW()
    `;
};

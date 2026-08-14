import { client as redisClient } from '../../config/redis.js';
import { LUCKY_GIFT_CONFIG } from '../../config/luckyGift.config.js';

const SPENT_KEY = "lucky:reserve:total_spent";
const REWARDED_KEY = "lucky:reserve:total_rewarded";
const POOL_KEY = "lucky:reserve:pool_balance";

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

    if (redisClient.isOpen) {
        try {
            await Promise.all([
                redisClient.incrBy(SPENT_KEY, Math.round(cost)),
                redisClient.incrBy(REWARDED_KEY, Math.round(reward)),
                redisClient.incrByFloat(POOL_KEY, netPoolChange)
            ]);
        } catch (e) {
            console.error("[ReservePool Engine] Redis update error:", e.message);
        }
    }

    return { inflow, outflow, netPoolChange };
};

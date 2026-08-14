import prisma from '../config/prisma.js';
import { client as redisClient } from '../config/redis.js';

/**
 * Fast sub-millisecond check for personal coins freeze restriction.
 * Uses Redis cache (`user:coins_frozen:${userId}`) with DB fallback.
 * Throws an Error if user's personal coins are frozen.
 */
export async function checkCoinsFrozenFast(userId) {
    if (!userId) return;

    const redisKey = `user:coins_frozen:${userId}`;

    try {
        if (redisClient.isOpen) {
            const cached = await redisClient.get(redisKey);
            if (cached !== null) {
                if (cached === "1" || cached === "true") {
                    throw new Error("Your personal coins are currently frozen by admin.");
                }
                return; // Cached as false / 0 -> proceed quickly
            }
        }
    } catch (redisErr) {
        if (redisErr.message === "Your personal coins are currently frozen by admin.") {
            throw redisErr;
        }
        // Fail silently to DB fallback if Redis error
    }

    // Fallback DB Lookup
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { personal_coins_frozen: true }
    });

    const isFrozen = Boolean(user && user.personal_coins_frozen);

    if (redisClient.isOpen) {
        // Cache frozen status for 5 minutes (300 seconds)
        redisClient.set(redisKey, isFrozen ? "1" : "0", { EX: 300 }).catch(() => { });
    }

    if (isFrozen) {
        throw new Error("Your personal coins are currently frozen by admin.");
    }
}

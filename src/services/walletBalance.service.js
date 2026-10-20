/**
 * The Redis wallet balance caches - the single place in Live-server allowed to touch them.
 *
 * Live-server makes no affordability decisions: since 2026-10-21 every coin/point write goes
 * through ol-node-rest's ledger (services/ledgerClient.js), which decides under FOR UPDATE on the
 * wallet rows and refreshes these caches itself. (The in-transaction balance reads, wallet locks
 * and freeze re-check that used to live here served Live-server's retired local money code.)
 *
 * `wallet:coins:{userId}` and `wallet:points:{userId}` are SHARED with ol-node-rest. They are a
 * post-commit, best-effort cache: NEVER part of a decision, and a failed cache write is never
 * fatal. A service that decided affordability from these keys would double-spend against the
 * other service.
 *
 * Nothing outside this module may read or write those keys.
 * Enforced by `npm run check:wallet-cache` (scripts/check-wallet-cache-usage.mjs).
 */

import { client as redisClient } from "../config/redis.js";

/** Matches ol-node-rest WALLET_BALANCE_TTL so the shared keys expire alike. */
export const WALLET_BALANCE_TTL_SECONDS = 3600;

export const coinCacheKey = (userId) => `wallet:coins:${userId}`;
export const pointCacheKey = (userId) => `wallet:points:${userId}`;

const writeCache = async (key, absolute) => {
    if (!redisClient.isOpen) return;
    try {
        await redisClient.set(key, absolute.toString(), { EX: WALLET_BALANCE_TTL_SECONDS });
    } catch {
        // Cache write failed - drop the key so the next read recomputes from
        // Postgres rather than serving whatever stale value is still there.
        try {
            await redisClient.del(key);
        } catch {
            // best-effort
        }
    }
};

/** Post-commit write-through of the committed coin balance. Never a decision. */
export const writeCoinBalanceCache = async (userId, absolute) => {
    await writeCache(coinCacheKey(userId), absolute);
};

/** Post-commit write-through of the committed point balance. Never a decision. */
export const writePointBalanceCache = async (userId, absolute) => {
    await writeCache(pointCacheKey(userId), absolute);
};

export const invalidateCoinBalanceCache = async (userId) => {
    if (!redisClient.isOpen) return;
    try {
        await redisClient.del(coinCacheKey(userId));
    } catch {
        // best-effort
    }
};

export const invalidatePointBalanceCache = async (userId) => {
    if (!redisClient.isOpen) return;
    try {
        await redisClient.del(pointCacheKey(userId));
    } catch {
        // best-effort
    }
};

/**
 * Cached coin balance for DISPLAY ONLY (wallet screens, headers). Returns null
 * on a miss so the caller falls back to Postgres. Never use the result to
 * decide whether a debit may proceed.
 */
export const readCoinBalanceCacheForDisplay = async (userId) => {
    if (!redisClient.isOpen) return null;
    try {
        const raw = await redisClient.get(coinCacheKey(userId));
        return raw === null || raw === undefined ? null : BigInt(raw);
    } catch {
        return null;
    }
};

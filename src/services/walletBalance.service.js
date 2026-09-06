/**
 * Wallet balance reads, wallet row locks, freeze checks and the Redis balance
 * caches - the single place in Live-server allowed to touch any of them.
 *
 * MONEY RULE (mirrors ol-node-rest src/services/gift-transaction.service.ts):
 *
 *   1. Every affordability decision is a ledger read taken INSIDE a Postgres
 *      transaction that already holds FOR UPDATE on the wallet row.
 *   2. Freeze state is re-checked inside that same transaction, under the same
 *      lock - never trusted from a time-based cache.
 *   3. Redis is a post-commit, best-effort write-through cache. It is NEVER
 *      part of a decision, and a failed cache write is never fatal.
 *
 * `wallet:coins:{userId}` and `wallet:points:{userId}` are SHARED with
 * ol-node-rest, which treats them exactly the same way. A service that decides
 * affordability from these keys double-spends against the other service: it
 * debits Redis, the peer commits from the (higher) Postgres balance and writes
 * that value back, and the debit is erased. Keeping both services
 * cache-only is what makes the shared key safe.
 *
 * Nothing outside this module may read or write those keys.
 * Enforced by `npm run check:wallet-cache` (scripts/check-wallet-cache-usage.mjs).
 */

import prisma from "../config/prisma.js";
import { client as redisClient } from "../config/redis.js";

/** Matches ol-node-rest WALLET_BALANCE_TTL so the shared keys expire alike. */
export const WALLET_BALANCE_TTL_SECONDS = 3600;

export const coinCacheKey = (userId) => `wallet:coins:${userId}`;
export const pointCacheKey = (userId) => `wallet:points:${userId}`;

const requireTx = (tx, fnName) => {
    if (!tx || typeof tx.coinLedgerEntry?.findFirst !== "function") {
        throw new Error(
            `${fnName} requires a Prisma transaction client - balances may only be read inside a transaction that holds the wallet lock.`
        );
    }
};

/**
 * Coin balance from the ledger. Transaction client is mandatory: callers must
 * already hold FOR UPDATE on the wallet row, otherwise the value is stale the
 * moment it is read.
 */
export const getCoinBalanceInTx = async (tx, walletId) => {
    requireTx(tx, "getCoinBalanceInTx");
    const latest = await tx.coinLedgerEntry.findFirst({
        where: { walletId },
        orderBy: { createdAt: "desc" },
        select: { balanceAfter: true }
    });
    return latest ? latest.balanceAfter : 0n;
};

/** Point balance from the ledger. Same locking contract as the coin read. */
export const getPointBalanceInTx = async (tx, walletId) => {
    requireTx(tx, "getPointBalanceInTx");
    const latest = await tx.pointLedgerEntry.findFirst({
        where: { walletId },
        orderBy: { createdAt: "desc" },
        select: { balanceAfter: true }
    });
    return latest ? latest.balanceAfter : 0n;
};

/**
 * Take FOR UPDATE on every wallet row, ordered by id so two transactions
 * touching the same pair can never deadlock against each other. Ids are bound
 * parameters, not interpolated.
 */
export const lockWalletsForUpdate = async (tx, walletIds) => {
    requireTx(tx, "lockWalletsForUpdate");
    const ordered = [...new Set(walletIds.filter(Boolean))].sort();
    for (const walletId of ordered) {
        // wallets.id is UUID; Prisma binds tagged-template params as text.
        await tx.$queryRaw`SELECT version FROM wallets WHERE id = ${walletId}::uuid FOR UPDATE`;
    }
    return ordered;
};

/**
 * Re-check the coin freeze under the wallet lock. `checkCoinsFrozenFast` is a
 * 5-minute Redis cache used only to reject obviously-frozen users early; a user
 * frozen since that cache was written must still be stopped here.
 */
export const assertCoinsNotFrozenInTx = async (tx, userId) => {
    requireTx(tx, "assertCoinsNotFrozenInTx");
    if (!userId) return;
    const user = await tx.user.findUnique({
        where: { id: userId },
        select: { personal_coins_frozen: true }
    });
    if (user && user.personal_coins_frozen) {
        throw new Error("Your personal coins are currently frozen by admin.");
    }
};

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

/** Postgres serialization failure / deadlock - safe to retry the whole tx. */
const isRetryableTxError = (err) => {
    const code = err?.code ?? err?.meta?.code;
    return code === "40001" || code === "40P01" || code === "P2034";
};

/**
 * Run an interactive transaction, retrying the bounded set of aborts Postgres
 * raises when two senders contend for the same wallet row.
 */
export const runMoneyTransaction = async (fn, options = {}) => {
    const { maxAttempts = 3, timeout = 15000, maxWait = 10000 } = options;
    for (let attempt = 1; ; attempt++) {
        try {
            return await prisma.$transaction(fn, { timeout, maxWait });
        } catch (err) {
            if (attempt < maxAttempts && isRetryableTxError(err)) {
                await new Promise((r) => setTimeout(r, 20 * attempt + Math.floor(Math.random() * 30)));
                continue;
            }
            throw err;
        }
    }
};

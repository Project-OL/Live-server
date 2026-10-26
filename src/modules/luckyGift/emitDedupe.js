/**
 * F6: emit lucky socket events at most once per gift transactionId.
 * Redis SET NX on `lucky:emitted:{transactionId}` (TTL 24h), set before emit.
 * If Redis is unavailable, emit anyway (prefer duplicate banner over a missing one) and log.
 *
 * Closeout A2: gated by LUCKY_EMIT_DEDUPE_ENABLED (default true). When false, every call
 * emits — identical to pre-water-level baseline (no Redis touch).
 */
import { client as redisClient } from '../../config/redis.js';

const TTL_SEC = 86_400;
const keyFor = (transactionId) => `lucky:emitted:${transactionId}`;

/** @returns {boolean} */
export function isLuckyEmitDedupeEnabled() {
    const v = process.env.LUCKY_EMIT_DEDUPE_ENABLED;
    if (v === undefined || v === '') return true;
    return !['0', 'false', 'False', 'FALSE', 'no', 'off'].includes(String(v));
}

/**
 * @param {string | null | undefined} transactionId
 * @returns {Promise<boolean>} true if this caller should emit (won the NX race, flag off, or Redis down)
 */
export async function claimLuckyEmit(transactionId) {
    if (!transactionId) return true;
    if (!isLuckyEmitDedupeEnabled()) return true;
    try {
        const ok = await redisClient.set(keyFor(String(transactionId)), '1', {
            NX: true,
            EX: TTL_SEC,
        });
        // node-redis returns 'OK' | null; some clients return true/false
        if (ok === null || ok === false || ok === 0) return false;
        return true;
    } catch (err) {
        console.error(
            `[LuckyEmitDedupe] Redis unavailable; emitting without dedupe for ${transactionId}: ${err?.message || err}`,
        );
        return true;
    }
}

/**
 * Run the lucky emit bundle at most once per transactionId.
 * @param {string | null | undefined} transactionId
 * @param {() => void | Promise<void>} emitFn
 * @returns {Promise<boolean>} whether emits ran
 */
export async function withLuckyEmitOnce(transactionId, emitFn) {
    if (!(await claimLuckyEmit(transactionId))) {
        console.log(`[LuckyEmitDedupe] skip duplicate lucky emits for ${transactionId}`);
        return false;
    }
    await emitFn();
    return true;
}

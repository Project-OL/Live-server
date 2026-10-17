import { client as redisClient } from "../config/redis.js";

/**
 * LIVE-32: never `KEYS` on the shared Redis. KEYS walks every key in one blocking call, which
 * stalls Redis for both services as the keyspace grows. SCAN walks it in small, non-blocking steps.
 * node-redis 6 yields batches (arrays); older versions yield single keys, so both are handled.
 */
export async function* scanKeys(pattern, count = 200) {
    if (!redisClient.isOpen) return;
    for await (const batch of redisClient.scanIterator({ MATCH: pattern, COUNT: count })) {
        if (Array.isArray(batch)) {
            for (const key of batch) yield key;
        } else if (batch) {
            yield batch;
        }
    }
}

/** UNLINK (non-blocking delete) every key matching `pattern`. Returns how many were removed. */
export const unlinkByPattern = async (pattern) => {
    if (!redisClient.isOpen) return 0;
    let removed = 0;
    let chunk = [];
    for await (const key of scanKeys(pattern)) {
        chunk.push(key);
        if (chunk.length >= 200) {
            removed += await redisClient.unlink(chunk);
            chunk = [];
        }
    }
    if (chunk.length) removed += await redisClient.unlink(chunk);
    return removed;
};

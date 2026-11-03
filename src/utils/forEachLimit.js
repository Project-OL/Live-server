/**
 * Run `fn(item, index)` over `items` with at most `limit` calls in flight.
 * Resolves when all are done. A rejected call is passed to `onError` (default: rethrown at the end,
 * after the other items have finished), so one bad item never stops the rest.
 *
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<unknown>} fn
 * @param {(err: unknown, item: T) => void} [onError]
 */
export const forEachLimit = async (items, limit, fn, onError) => {
    const n = Array.isArray(items) ? items.length : 0;
    if (n === 0) return;
    const width = Math.max(1, Math.min(n, Math.floor(Number(limit)) || 1));
    let next = 0;
    let firstErr = null;
    const worker = async () => {
        while (next < n) {
            const i = next++;
            try {
                await fn(items[i], i);
            } catch (err) {
                if (onError) onError(err, items[i]);
                else if (!firstErr) firstErr = err;
            }
        }
    };
    await Promise.all(Array.from({ length: width }, worker));
    if (firstErr) throw firstErr;
};

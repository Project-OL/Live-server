/**
 * F10: the caller's coin price per video-call minute, from the same admin setting the ledger bills
 * with (`host_revenue_share_config.video_call_host_share_bp`, ol-node-rest
 * `callerCoinDebitForCall`): coins = ceil(pricePerMin * 10000 / hostShareBp). It was hard-coded as
 * ceil(pricePerMin * 5 / 3) (a 60% host share), so an admin change made Live-server's balance checks
 * and displayed rates disagree with what the ledger charges. With the default 6000 the result is
 * identical to the old formula.
 *
 * Read order as in luckyShares.service.js: ol-node-rest's cache `host:revenue-shares`, then the DB
 * row, then 6000. Memoized per process for 30 s.
 */
import prisma from "../config/prisma.js";
import { client as redisClient } from "../config/redis.js";

const CONFIG_KEY = "host:revenue-shares";
const MEMO_MS = 30_000;
export const DEFAULT_VIDEO_CALL_HOST_SHARE_BP = 6000;
const valid = (v) => Number.isInteger(v) && v >= 1000 && v <= 10000;

let memo = { at: 0, value: null };

const pick = (src) => {
    if (!src) return null;
    const bp = Number(src.videoCallHostShareBp ?? src.video_call_host_share_bp);
    return valid(bp) ? bp : null;
};

/** @returns {Promise<number>} the host's share of a call minute, in basis points. */
export const getVideoCallHostShareBp = async () => {
    if (memo.value && Date.now() - memo.at < MEMO_MS) return memo.value;
    let value = null;
    if (redisClient.isOpen) {
        try {
            const raw = await redisClient.get(CONFIG_KEY);
            value = raw ? pick(JSON.parse(raw)) : null;
        } catch {
            value = null;
        }
    }
    if (!value) {
        try {
            const rows = await prisma.$queryRaw`
                SELECT video_call_host_share_bp FROM host_revenue_share_config WHERE id = 1
            `;
            value = pick(rows?.[0]);
        } catch {
            value = null;
        }
    }
    memo = { at: Date.now(), value: value || DEFAULT_VIDEO_CALL_HOST_SHARE_BP };
    return memo.value;
};

/** Caller coins per minute for a host price, with the given share (ledger's ceiling division). */
export const callerCoinsPerMinute = (pricePerMin, hostShareBp = DEFAULT_VIDEO_CALL_HOST_SHARE_BP) => {
    const price = BigInt(Math.max(0, Math.trunc(Number(pricePerMin) || 0)));
    if (price === 0n) return 0n;
    const den = BigInt(hostShareBp);
    return (price * 10000n + den - 1n) / den;
};

/** Convenience: the current caller coin rate for a host price. */
export const currentCallerCoinsPerMinute = async (pricePerMin) =>
    callerCoinsPerMinute(pricePerMin, await getVideoCallHostShareBp());

/** Tests only. */
export const resetCallRateMemo = () => {
    memo = { at: 0, value: null };
};

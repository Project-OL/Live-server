/**
 * Lucky gift admin settings (BE-20 step 1.3): the host cut and the reserve-pool RTP target, owned by
 * ol-node-rest (`host_revenue_share_config.lucky_host_share_bp` / `lucky_target_rtp_bp`, edited on
 * the admin System Settings page).
 *
 * Read order: ol-node-rest's shared config cache `host:revenue-shares` (busted on every admin save),
 * then the DB row, then the original constants (src/config/luckyGift.config.js). Only read, never
 * written here: ol-node-rest owns the key and its shape. Memoized per process for 30 s.
 */
import prisma from "../config/prisma.js";
import { client as redisClient } from "../config/redis.js";
import { LUCKY_GIFT_CONFIG } from "../config/luckyGift.config.js";

const CONFIG_KEY = "host:revenue-shares";
const MEMO_MS = 30_000;
const HOST_RANGE = { min: 0, max: 2000 };
const RTP_RANGE = { min: 5000, max: 9900 };

const DEFAULTS = {
    luckyHostShareBp: Math.round((LUCKY_GIFT_CONFIG.hostEarningPercent ?? 4) * 100),
    luckyTargetRtpBp: Math.round((LUCKY_GIFT_CONFIG.targetRtpPercent ?? 92) * 100)
};

let memo = { at: 0, value: null };

const valid = (v, r) => Number.isInteger(v) && v >= r.min && v <= r.max;

const pick = (src) => {
    if (!src) return null;
    const host = Number(src.luckyHostShareBp ?? src.lucky_host_share_bp);
    const rtp = Number(src.luckyTargetRtpBp ?? src.lucky_target_rtp_bp);
    return valid(host, HOST_RANGE) && valid(rtp, RTP_RANGE) ? { luckyHostShareBp: host, luckyTargetRtpBp: rtp } : null;
};

/** @returns {Promise<{ luckyHostShareBp: number, luckyTargetRtpBp: number }>} */
export const getLuckyShares = async () => {
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
            // Raw SQL: the columns are added by an ol-node-rest migration, and Live-server must keep
            // working (on the defaults) if it deploys first.
            const rows = await prisma.$queryRaw`
                SELECT lucky_host_share_bp, lucky_target_rtp_bp FROM host_revenue_share_config WHERE id = 1
            `;
            value = pick(rows?.[0]);
        } catch {
            value = null;
        }
    }
    memo = { at: Date.now(), value: value || DEFAULTS };
    return memo.value;
};

/** Tests only. */
export const resetLuckySharesMemo = () => {
    memo = { at: 0, value: null };
};

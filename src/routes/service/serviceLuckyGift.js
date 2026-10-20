/**
 * Lucky Gift Services
 * 
 * Handles host 4% payout, 92% RTP sender lucky reward calculation,
 * and atomic database transaction execution for lucky gifts.
 */

import prisma from '../../config/prisma.js';
import crypto from 'crypto';
import { client as redisClient } from '../../config/redis.js';
import { LUCKY_GIFT_CONFIG } from '../../config/luckyGift.config.js';
import { giftImageFields } from '../../utils/giftImage.js';
import { getGiftInfoService, isLuckyGift } from './serviceLive.js';
import { getReservePoolStats, calculateSingleReward as calcSingle, calculateComboReward as calcCombo } from '../../modules/luckyGift/index.js';
import { checkCoinsFrozenFast } from '../../utils/coinRestriction.js';
import { callLedger, toLocalError } from '../../services/ledgerClient.js';

/** Host cut in points. `hostShareBp` is the admin setting (luckyShares.service.js), default 400 = 4%. */
export const calculateHostEarning = ({ totalCost, hostShareBp = Math.round(LUCKY_GIFT_CONFIG.hostEarningPercent * 100) }) => {
    const costBigInt = BigInt(totalCost);
    const hostPoints = (costBigInt * BigInt(hostShareBp)) / 10000n;
    return hostPoints > 0n ? hostPoints : 0n;
};

export const calculateSingleReward = calcSingle;
export const calculateComboReward = calcCombo;

/**
 * BE-20 remote ledger for a lucky gift. The RTP draw (`luckyResult`) and the reserve pool stay
 * here; ol-node-rest writes the debit, reward, host cut, levels and (combo only) commission.
 * Returns the same fields as the local transaction.
 */
const luckyGiftRemoteLedger = async ({ senderId, receiverId, gift, count, giftTransactionId, txKeyBase, luckyResult }) => {
    let r;
    try {
        r = await callLedger("LUCKY_GIFT", "lucky-gift", {
            senderId,
            receiverId: receiverId || null,
            giftId: gift.id,
            count,
            giftTransactionId,
            txKeyBase,
            rewardCoins: String(luckyResult.totalReward),
            category: String(luckyResult.category || "LUCKY")
        });
    } catch (err) {
        throw toLocalError(err, {
            insufficient: (d) => `Insufficient coin balance. Required: ${d.required}, Available: ${d.balance}`
        });
    }
    return {
        log: { id: r.transactionId },
        hostLedgerId: null,
        agencyUserId: r.agencyUserId ?? null,
        finalBalanceCoins: BigInt(r.finalBalanceCoins),
        pointsAfterHost: r.pointsAfterHost != null ? BigInt(r.pointsAfterHost) : null,
        effectiveReceiverId: r.effectiveReceiverId,
        wealth: r.wealth,
        hostPoints: BigInt(r.hostPoints)
    };
};

export const sendLuckyGiftService = async ({
    senderId,
    receiverId,
    streamId,
    giftId,
    comboCount = 1,
    clientTxId = null,
    preFetchedGift = null
}) => {
    // Fast pre-check only; re-checked under the wallet lock inside the tx.
    await checkCoinsFrozenFast(senderId);
    // SEC-11: scoped to the sender, so one user's clientTxId can never replay another's result.
    const idemKey = clientTxId ? `lucky:idempotency:${senderId}:${clientTxId}` : null;
    if (idemKey) {
        const cachedTx = await redisClient.get(idemKey);
        if (cachedTx) {
            console.log(`[LuckyGift Service] Idempotent request hit for txId: ${clientTxId}`);
            return JSON.parse(cachedTx);
        }
    }

    const count = Math.max(1, Math.min(1000, Number(comboCount)));

    let gift = preFetchedGift;
    if (!gift) {
        // Direct POST /lucky-gift/send: the caller picks the gift, so it must be an
        // active lucky gift (sendStreamGiftService already checked this before
        // passing preFetchedGift).
        gift = await getGiftInfoService({ giftId });
        if (!gift || !gift.isActive) {
            throw new Error("Gift not found or is inactive.");
        }
        if (!isLuckyGift(gift)) {
            throw new Error("This gift is not a lucky gift.");
        }
    }

    if (!gift) {
        throw new Error("Gift not found");
    }

    const unitCost = BigInt(gift.coinCost);
    const totalCost = unitCost * BigInt(count);
    const isCombo = count > 1;

    // Fetch Realtime Reserve Pool & Dynamic RTP Stats
    const poolStats = await getReservePoolStats();

    let luckyResult;
    if (isCombo) {
        luckyResult = calcCombo({
            giftCoinCost: gift.coinCost,
            comboCount: count,
            currentRtp: poolStats.currentRtp,
            targetRtp: poolStats.targetRtp
        });
    } else {
        const single = calcSingle({
            giftCoinCost: gift.coinCost,
            currentRtp: poolStats.currentRtp,
            targetRtp: poolStats.targetRtp
        });
        luckyResult = {
            totalCost,
            totalReward: single.rewardCoins,
            breakdownArray: [Number(single.rewardCoins)],
            category: single.category
        };
    }

    const giftTransactionId = crypto.randomUUID();
    // Deterministic per logical send: a client-supplied txId when there is one,
    // otherwise the gift transaction id, which is stable across tx retries.
    const txKeyBase = clientTxId ? `lucky:${senderId}:${clientTxId}` : `lucky:${giftTransactionId}`;

    // BE-20: ol-node-rest's ledger checks the sender can afford the FULL cost (the reward is a
    // separate credit, not a discount), then writes the debit, reward, host cut, levels, combo-only
    // agency commission and the reserve-pool counters in one locked transaction, and refreshes the
    // caches. Live-server's own copy of this transaction was retired on 2026-10-21.
    const txRecord = await luckyGiftRemoteLedger({ senderId, receiverId, gift, count, giftTransactionId, txKeyBase, luckyResult });
    const hostPoints = txRecord.hostPoints;
    const finalBalanceCoins = txRecord.finalBalanceCoins;
    const wealthLevel = txRecord.wealth.newLevel;
    const isLevelUp = txRecord.wealth.newLevel > txRecord.wealth.previousLevel;

    const resultPayload = {
        success: true,
        transactionId: txRecord.log.id,
        isLucky: true,
        streamId,
        senderId,
        receiverId,
        gift: {
            id: gift.id,
            name: gift.name,
            ...giftImageFields(gift),
            coinCost: gift.coinCost,
            effectLuckyGift: true
        },
        count,
        totalCost: Number(totalCost),
        hostEarningPoints: Number(hostPoints),
        totalRewardCoins: Number(luckyResult.totalReward),
        breakdownArray: luckyResult.breakdownArray,
        category: luckyResult.category,
        senderRemainingCoins: Number(finalBalanceCoins),
        currentLevel: wealthLevel,
        isLevelUp,
        socketPayload: {
            success: true,
            streamId,
            senderId,
            senderRemainingCoins: Number(finalBalanceCoins),
            receiverId,
            gift: {
                id: gift.id,
                name: gift.name,
                ...giftImageFields(gift),
                coinCost: gift.coinCost,
                effectLuckyGift: true
            },
            count,
            totalCost: Number(totalCost),
            pointsAwarded: Number(hostPoints),
            wealthLevel,
            isLevelUp,
            isLucky: true
        },
        luckyWin: luckyResult.totalReward > 0n ? {
            senderId,
            receiverId,
            giftId: gift.id,
            giftName: gift.name,
            giftDisplayImageUrl: giftImageFields(gift).displayImageUrl,
            unitCoinCost: gift.coinCost,
            rewardCoins: Number(luckyResult.totalReward),
            category: luckyResult.category,
            breakdownArray: luckyResult.breakdownArray
        } : null
    };

    if (idemKey) {
        // node-redis takes options as an object; the positional ioredis form
        // ('EX', 86400) silently left these replay snapshots without a TTL.
        await redisClient.set(idemKey, JSON.stringify(resultPayload), { EX: 86400 });
    }

    return resultPayload;
};

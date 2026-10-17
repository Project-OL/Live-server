/**
 * Lucky Gift Services
 * 
 * Handles host 4% payout, 92% RTP sender lucky reward calculation,
 * and atomic database transaction execution for lucky gifts.
 */

import prisma from '../../config/prisma.js';
import crypto from 'crypto';
import { client as redisClient } from '../../config/redis.js';
import { WalletCurrencyType, LedgerDirection, CoinTxType, PointTxType, LevelType } from '@prisma/client';
import { LUCKY_GIFT_CONFIG } from '../../config/luckyGift.config.js';
import { getOrCreateWallet, updateUserLevel } from '../../modules/videoCall/service.js';
import { giftImageFields } from '../../utils/giftImage.js';
import { processLiveStreamAgencyCommission, getGiftInfoService, isLuckyGift } from './serviceLive.js';
import { afterCommissionCreditCommit } from '../../services/agencyTierRecompute.service.js';
import { getReservePoolStats, updateReservePool, calculateSingleReward as calcSingle, calculateComboReward as calcCombo } from '../../modules/luckyGift/index.js';
import { checkCoinsFrozenFast } from '../../utils/coinRestriction.js';
import { callLedger, ledgerMode, toLocalError } from '../../services/ledgerClient.js';
import { getLuckyShares } from '../../services/luckyShares.service.js';
import {
    getCoinBalanceInTx,
    getPointBalanceInTx,
    lockWalletsForUpdate,
    assertCoinsNotFrozenInTx,
    writeCoinBalanceCache,
    writePointBalanceCache,
    runMoneyTransaction
} from '../../services/walletBalance.service.js';

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

    const { luckyHostShareBp } = await getLuckyShares();
    let hostPoints = calculateHostEarning({ totalCost, hostShareBp: luckyHostShareBp });
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
    const luckyContext = isCombo ? "LUCKY_COMBO" : "LUCKY_SINGLE";
    // Deterministic per logical send: a client-supplied txId when there is one,
    // otherwise the gift transaction id, which is stable across tx retries.
    const txKeyBase = clientTxId ? `lucky:${senderId}:${clientTxId}` : `lucky:${giftTransactionId}`;

    // The sender must be able to afford the FULL gift cost before any reward is
    // credited back - the lucky reward is a separate credit, not a discount.
    // Affordability is read from the ledger under FOR UPDATE, never from Redis.
    const remoteLedger = ledgerMode("LUCKY_GIFT") === "remote";
    const txRecord = remoteLedger
        ? await luckyGiftRemoteLedger({ senderId, receiverId, gift, count, giftTransactionId, txKeyBase, luckyResult })
        : await runMoneyTransaction(async (tx) => {
        const effectiveReceiverId = receiverId || senderId;
        const senderWallet = await getOrCreateWallet(senderId, WalletCurrencyType.COIN, tx);
        const hostWallet = await getOrCreateWallet(effectiveReceiverId, WalletCurrencyType.POINT, tx);

        await lockWalletsForUpdate(tx, [senderWallet.id, hostWallet.id]);
        await assertCoinsNotFrozenInTx(tx, senderId);

        const currentSenderCoins = await getCoinBalanceInTx(tx, senderWallet.id);
        if (currentSenderCoins < totalCost) {
            throw new Error(
                `Insufficient coin balance. Required: ${totalCost}, Available: ${currentSenderCoins}`
            );
        }
        const coinsAfterDebit = currentSenderCoins - totalCost;

        await tx.coinLedgerEntry.create({
            data: {
                walletId: senderWallet.id,
                amount: totalCost,
                direction: LedgerDirection.DEBIT,
                txType: CoinTxType.GIFT_SEND,
                balanceAfter: coinsAfterDebit,
                idempotencyKey: `${txKeyBase}-debit`,
                refId: giftTransactionId,
                counterpartyId: effectiveReceiverId,
                description: `Lucky Gift Sent: ${gift.name} x${count}`,
                metadata: {
                    giftId: gift.id,
                    giftTransactionId,
                    context: luckyContext,
                    quantity: count
                }
            }
        });

        // Wealth XP tracks coin SPEND: the full gift cost, like every other gift.
        // The lucky reward is a separate PLATFORM_REWARD credit and does not reduce it.
        const wealth = await updateUserLevel(tx, senderId, LevelType.WEALTH, totalCost);

        let finalBalanceCoins = coinsAfterDebit;
        if (luckyResult.totalReward > 0n) {
            const coinsAfterCredit = coinsAfterDebit + luckyResult.totalReward;
            finalBalanceCoins = coinsAfterCredit;
            await tx.coinLedgerEntry.create({
                data: {
                    walletId: senderWallet.id,
                    amount: luckyResult.totalReward,
                    direction: LedgerDirection.CREDIT,
                    txType: CoinTxType.PLATFORM_REWARD,
                    balanceAfter: coinsAfterCredit,
                    idempotencyKey: `${txKeyBase}-reward`,
                    refId: giftTransactionId,
                    description: `Lucky Winner: ${gift.name} (${luckyResult.category})`
                }
            });
        }

        await tx.wallet.update({
            where: { id: senderWallet.id },
            data: { version: { increment: 1n } }
        });

        let hostLedgerId = null;
        let pointsAfterHost = null;
        if (hostPoints > 0n && hostWallet) {
            const currentHostPoints = await getPointBalanceInTx(tx, hostWallet.id);
            pointsAfterHost = currentHostPoints + hostPoints;

            const hostLedger = await tx.pointLedgerEntry.create({
                data: {
                    walletId: hostWallet.id,
                    amount: hostPoints,
                    direction: LedgerDirection.CREDIT,
                    txType: PointTxType.LIVESTREAM_GIFT,
                    balanceAfter: pointsAfterHost,
                    idempotencyKey: `${txKeyBase}-host-cut`,
                    refId: giftTransactionId,
                    counterpartyId: senderId,
                    description: `Received Lucky Gift: ${gift.name}`,
                    metadata: {
                        giftId: gift.id,
                        giftName: gift.name,
                        context: luckyContext,
                        quantity: count,
                        unitCoinCost: Number(gift.coinCost),
                        giftTransactionId
                    }
                }
            });
            hostLedgerId = hostLedger.id;

            // Host livestream-level XP, same rule as normal gifts: XP grows by the points the host
            // receives (here the lucky host cut). Decided 2026-10-17; before, lucky gifts gave none.
            await updateUserLevel(tx, effectiveReceiverId, LevelType.LIVESTREAM, hostPoints);
        }

        // Agency commission settles in the same transaction as the host credit
        // it derives from, so the two can never diverge. Business rule (confirmed
        // 2026-10-17): only combo lucky gifts pay agency commission, single ones don't.
        let agencyUserId = null;
        if (isCombo && hostPoints > 0n && hostLedgerId) {
            const commRes = await processLiveStreamAgencyCommission(
                tx,
                effectiveReceiverId,
                hostPoints,
                hostLedgerId,
                null,
                {
                    businessRefId: giftTransactionId,
                    hostTxType: PointTxType.LIVESTREAM_GIFT,
                    gift,
                    context: luckyContext,
                    quantity: count,
                    unitCoinCost: Number(gift.coinCost)
                }
            );
            agencyUserId = commRes?.agencyUserId ?? null;
        }

        const log = await tx.giftTransaction.create({
            data: {
                id: giftTransactionId,
                senderUserId: senderId,
                receiverUserId: effectiveReceiverId,
                giftId: gift.id,
                coinCost: Number(totalCost),
                quantity: count,
                pointsAwarded: Number(hostPoints),
                context: luckyContext
            }
        });

        return { log, hostLedgerId, agencyUserId, finalBalanceCoins, pointsAfterHost, effectiveReceiverId, wealth };
    });

    // Remote mode: ol-node-rest's host cut is the one written (same admin setting, but its cache may be fresher).
    if (txRecord.hostPoints != null) hostPoints = txRecord.hostPoints;
    const finalBalanceCoins = txRecord.finalBalanceCoins;
    const wealthLevel = txRecord.wealth.newLevel;
    const isLevelUp = txRecord.wealth.newLevel > txRecord.wealth.previousLevel;

    // Committed. Everything below is best-effort and must not fail the send.
    // (Remote mode: ol-node-rest already refreshed the balance/level caches and the agency tier.)
    if (!remoteLedger) {
        await writeCoinBalanceCache(senderId, finalBalanceCoins);
        if (txRecord.pointsAfterHost !== null) {
            await writePointBalanceCache(txRecord.effectiveReceiverId, txRecord.pointsAfterHost);
        }
    }

    if (txRecord.agencyUserId && !remoteLedger) {
        await afterCommissionCreditCommit(txRecord.agencyUserId).catch((err) =>
            console.error("[LuckyGift] agency tier recompute failed:", err.message)
        );
    }

    // Reserve pool counters drive payout odds, so a lost update skews RTP for
    // every later draw. Awaited and logged against the transaction id rather
    // than fired into a background task that swallows its own failure.
    try {
        await updateReservePool({ giftCost: totalCost, rewardCoins: luckyResult.totalReward });
    } catch (poolErr) {
        console.error(
            `[LuckyGift] reserve pool update FAILED for giftTransactionId=${giftTransactionId} cost=${totalCost} reward=${luckyResult.totalReward}:`,
            poolErr.message
        );
    }

    if (!remoteLedger && redisClient.isOpen) {
        redisClient.del(`level:wealth:${senderId}`).catch(() => {});
        if (receiverId) redisClient.del(`level:stream:${receiverId}`).catch(() => {});
    }

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

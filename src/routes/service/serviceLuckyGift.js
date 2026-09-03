/**
 * Lucky Gift Services
 * 
 * Handles host 4% payout, 92% RTP sender lucky reward calculation,
 * and atomic database transaction execution for lucky gifts.
 */

import prisma from '../../config/prisma.js';
import crypto from 'crypto';
import { client as redisClient } from '../../config/redis.js';
import { WalletCurrencyType, LedgerDirection, CoinTxType, PointTxType } from '@prisma/client';
import { LUCKY_GIFT_CONFIG } from '../../config/luckyGift.config.js';
import { getOrCreateWallet, getFastCoinBalance, getFastPointBalance } from '../../modules/videoCall/service.js';
import { processLiveStreamAgencyCommission } from './serviceLive.js';
import { afterCommissionCreditCommit } from '../../services/agencyTierRecompute.service.js';
import { getReservePoolStats, updateReservePool, calculateSingleReward as calcSingle, calculateComboReward as calcCombo } from '../../modules/luckyGift/index.js';
import { checkCoinsFrozenFast } from '../../utils/coinRestriction.js';

export const calculateHostEarning = ({ totalCost }) => {
    const costBigInt = BigInt(totalCost);
    const hostPercentBigInt = BigInt(Math.round(LUCKY_GIFT_CONFIG.hostEarningPercent));
    const hostPoints = (costBigInt * hostPercentBigInt) / 100n;
    return hostPoints > 0n ? hostPoints : 0n;
};

export const calculateSingleReward = calcSingle;
export const calculateComboReward = calcCombo;

export const sendLuckyGiftService = async ({
    senderId,
    receiverId,
    streamId,
    giftId,
    comboCount = 1,
    clientTxId = null,
    preFetchedGift = null
}) => {
    await checkCoinsFrozenFast(senderId);
    if (clientTxId) {
        const cachedTx = await redisClient.get(`lucky:idempotency:${clientTxId}`);
        if (cachedTx) {
            console.log(`[LuckyGift Service] Idempotent request hit for txId: ${clientTxId}`);
            return JSON.parse(cachedTx);
        }
    }

    const count = Math.max(1, Math.min(1000, Number(comboCount)));

    let gift = preFetchedGift;
    if (!gift) {
        gift = await prisma.gift.findUnique({ where: { id: giftId } });
    }

    if (!gift) {
        throw new Error("Gift not found");
    }

    const unitCost = BigInt(gift.coinCost);
    const totalCost = unitCost * BigInt(count);

    const senderWallet = await getOrCreateWallet(senderId, WalletCurrencyType.COIN);
    const walletKey = `wallet:coins:${senderId}`;
    let senderCoinsStr = redisClient.isOpen ? await redisClient.get(walletKey) : null;
    let senderCoins;

    if (senderCoinsStr === null) {
        senderCoins = await getFastCoinBalance(senderWallet.id);
    } else {
        senderCoins = BigInt(senderCoinsStr);
    }

    if (senderCoins < totalCost) {
        throw new Error(`Insufficient coin balance. Required: ${totalCost}, Available: ${senderCoins}`);
    }

    const hostPoints = calculateHostEarning({ totalCost });
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

    const netSenderDeduction = totalCost - luckyResult.totalReward;
    const finalBalanceCoins = senderCoins - netSenderDeduction;

    if (redisClient.isOpen) {
        await redisClient.set(walletKey, finalBalanceCoins.toString(), "EX", 3600);
    }

    const giftTransactionId = crypto.randomUUID();
    const luckyContext = isCombo ? "LUCKY_COMBO" : "LUCKY_SINGLE";
    const txRecord = await prisma.$transaction(async (tx) => {
        const effectiveReceiverId = receiverId || senderId;
        const hostWallet = await getOrCreateWallet(effectiveReceiverId, WalletCurrencyType.POINT, tx);

        const currentSenderCoins = senderCoins;
        const coinsAfterDebit = currentSenderCoins - totalCost;

        const txKeyBase = clientTxId || `lucky-${gift.id}-${senderId}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

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

        if (luckyResult.totalReward > 0n) {
            const coinsAfterCredit = coinsAfterDebit + luckyResult.totalReward;
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

        let hostLedgerId = null;
        if (hostPoints > 0n && hostWallet) {
            const currentHostPoints = await getFastPointBalance(hostWallet.id, tx);
            const pointsAfterHost = currentHostPoints + hostPoints;

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

        return { log, hostLedgerId };
    }, { timeout: 15000, maxWait: 10000 });

    // Non-blocking background worker for Agency Commission, Reserve Pool & Level Cache invalidating
    setImmediate(async () => {
        try {
            if (isCombo && hostPoints > 0n && txRecord.hostLedgerId) {
                const effectiveReceiverId = receiverId || senderId;
                const commRes = await processLiveStreamAgencyCommission(
                    prisma,
                    effectiveReceiverId,
                    hostPoints,
                    txRecord.hostLedgerId,
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
                if (commRes?.agencyUserId) {
                    await afterCommissionCreditCommit(commRes.agencyUserId);
                }
            }
            await updateReservePool({ giftCost: totalCost, rewardCoins: luckyResult.totalReward });
            if (redisClient.isOpen) {
                redisClient.del(`level:wealth:${senderId}`).catch(() => {});
                if (receiverId) redisClient.del(`level:stream:${receiverId}`).catch(() => {});
            }
        } catch (bgErr) {
            console.error("[LuckyGift Background Worker Error]:", bgErr.message);
        }
    });

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
            displayImageUrl: gift.displayImageUrl,
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
        socketPayload: {
            success: true,
            streamId,
            senderId,
            senderRemainingCoins: Number(finalBalanceCoins),
            receiverId,
            gift: {
                id: gift.id,
                name: gift.name,
                displayImageUrl: gift.displayImageUrl,
                coinCost: gift.coinCost,
                effectLuckyGift: true
            },
            count,
            totalCost: Number(totalCost),
            pointsAwarded: Number(hostPoints),
            isLucky: true
        },
        luckyWin: luckyResult.totalReward > 0n ? {
            senderId,
            receiverId,
            giftId: gift.id,
            giftName: gift.name,
            giftDisplayImageUrl: gift.displayImageUrl,
            unitCoinCost: gift.coinCost,
            rewardCoins: Number(luckyResult.totalReward),
            category: luckyResult.category,
            breakdownArray: luckyResult.breakdownArray
        } : null
    };

    if (clientTxId) {
        await redisClient.set(`lucky:idempotency:${clientTxId}`, JSON.stringify(resultPayload), 'EX', 86400);
    }

    return resultPayload;
};

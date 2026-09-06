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
import { getOrCreateWallet } from '../../modules/videoCall/service.js';
import { processLiveStreamAgencyCommission } from './serviceLive.js';
import { afterCommissionCreditCommit } from '../../services/agencyTierRecompute.service.js';
import { getReservePoolStats, updateReservePool, calculateSingleReward as calcSingle, calculateComboReward as calcCombo } from '../../modules/luckyGift/index.js';
import { checkCoinsFrozenFast } from '../../utils/coinRestriction.js';
import {
    getCoinBalanceInTx,
    getPointBalanceInTx,
    lockWalletsForUpdate,
    assertCoinsNotFrozenInTx,
    writeCoinBalanceCache,
    writePointBalanceCache,
    runMoneyTransaction
} from '../../services/walletBalance.service.js';

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
    // Fast pre-check only; re-checked under the wallet lock inside the tx.
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

    const giftTransactionId = crypto.randomUUID();
    const luckyContext = isCombo ? "LUCKY_COMBO" : "LUCKY_SINGLE";
    // Deterministic per logical send: a client-supplied txId when there is one,
    // otherwise the gift transaction id, which is stable across tx retries.
    const txKeyBase = clientTxId ? `lucky:${senderId}:${clientTxId}` : `lucky:${giftTransactionId}`;

    // The sender must be able to afford the FULL gift cost before any reward is
    // credited back - the lucky reward is a separate credit, not a discount.
    // Affordability is read from the ledger under FOR UPDATE, never from Redis.
    const txRecord = await runMoneyTransaction(async (tx) => {
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
        }

        // Agency commission settles in the same transaction as the host credit
        // it derives from, so the two can never diverge.
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

        return { log, hostLedgerId, agencyUserId, finalBalanceCoins, pointsAfterHost, effectiveReceiverId };
    });

    const finalBalanceCoins = txRecord.finalBalanceCoins;

    // Committed. Everything below is best-effort and must not fail the send.
    await writeCoinBalanceCache(senderId, finalBalanceCoins);
    if (txRecord.pointsAfterHost !== null) {
        await writePointBalanceCache(txRecord.effectiveReceiverId, txRecord.pointsAfterHost);
    }

    if (txRecord.agencyUserId) {
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

    if (redisClient.isOpen) {
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
        // node-redis takes options as an object; the positional ioredis form
        // ('EX', 86400) silently left these replay snapshots without a TTL.
        await redisClient.set(`lucky:idempotency:${clientTxId}`, JSON.stringify(resultPayload), { EX: 86400 });
    }

    return resultPayload;
};

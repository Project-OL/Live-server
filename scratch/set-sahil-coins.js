import { PrismaClient, WalletCurrencyType, LedgerDirection, CoinTxType } from '@prisma/client';
import { createClient } from 'redis';
import dotenv from 'dotenv';
dotenv.config();

const prisma = new PrismaClient();

const sahilId = "db734ed8-08fe-4e9d-9817-0429320bd706";

async function checkBalance(userId) {
    let wallet = await prisma.wallet.findUnique({
        where: { userId_currencyType: { userId, currencyType: WalletCurrencyType.COIN } }
    });
    if (!wallet) return 0n;

    const credits = await prisma.coinLedgerEntry.aggregate({
        where: { walletId: wallet.id, direction: LedgerDirection.CREDIT },
        _sum: { amount: true }
    });
    const debits = await prisma.coinLedgerEntry.aggregate({
        where: { walletId: wallet.id, direction: LedgerDirection.DEBIT },
        _sum: { amount: true }
    });
    return (credits._sum.amount ?? 0n) - (debits._sum.amount ?? 0n);
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log("🔍 Fetching current balance from database...");
        const sahilCoins = await checkBalance(sahilId);
        console.log("==========================================");
        console.log(`👤 User 'sahil' (Caller) : ${sahilCoins} Coins`);
        console.log("==========================================");
        process.exit(0);
    }

    const targetCoinsInput = parseInt(args[0], 10);
    if (isNaN(targetCoinsInput) || targetCoinsInput < 0) {
        console.error("❌ Please provide a valid non-negative number of coins to set.");
        process.exit(1);
    }

    const targetCoins = BigInt(targetCoinsInput);

    console.log(`Setting sahil's wallet balance to exactly: ${targetCoins} coins...`);

    const sahil = await prisma.user.findUnique({ where: { id: sahilId } });
    if (!sahil) {
        console.error("❌ User 'sahil' (ID: ab02afd3-663b-41f0-9cc5-db22c134dd04) not found in database.");
        process.exit(1);
    }

    const redisClient = createClient({ url: process.env.REDIS_URL || "redis://localhost:6379" });
    await redisClient.connect();

    let wallet = await prisma.wallet.findUnique({
        where: { userId_currencyType: { userId: sahilId, currencyType: WalletCurrencyType.COIN } }
    });
    if (!wallet) {
        wallet = await prisma.wallet.create({
            data: {
                userId: sahilId,
                currencyType: WalletCurrencyType.COIN,
                version: 0n
            }
        });
    }

    const currentBalance = await checkBalance(sahilId);
    console.log(`Current Coins Balance: ${currentBalance}`);

    const delta = targetCoins - currentBalance;

    if (delta > 0n) {
        await prisma.coinLedgerEntry.create({
            data: {
                walletId: wallet.id,
                direction: LedgerDirection.CREDIT,
                txType: CoinTxType.ADJUSTMENT,
                amount: delta,
                balanceAfter: targetCoins,
                idempotencyKey: `adjustment-credit-sahil-${Date.now()}`,
                description: `Manual adjustment credit of ${delta} coins`
            }
        });
        console.log(`✅ Credited ${delta} coins to wallet.`);
    } else if (delta < 0n) {
        const debitAmount = -delta;
        await prisma.coinLedgerEntry.create({
            data: {
                walletId: wallet.id,
                direction: LedgerDirection.DEBIT,
                txType: CoinTxType.ADJUSTMENT,
                amount: debitAmount,
                balanceAfter: targetCoins,
                idempotencyKey: `adjustment-debit-sahil-${Date.now()}`,
                description: `Manual adjustment debit of ${debitAmount} coins`
            }
        });
        console.log(`✅ Debited ${debitAmount} coins from wallet.`);
    } else {
        console.log("ℹ️ Wallet balance is already at the target amount. No adjustment needed.");
    }

    const cacheKey = `wallet:coins:${sahilId}`;
    await redisClient.del(cacheKey);
    console.log(`Cleared Redis cache key: ${cacheKey}`);

    const verifiedBalance = await checkBalance(sahilId);
    console.log(`🔍 Verified final balance in database: ${verifiedBalance} coins`);

    await redisClient.quit();
    console.log(`🎉 Successfully set sahil's balance to ${targetCoins} coins!`);
}

main().catch(console.error).finally(() => prisma.$disconnect());

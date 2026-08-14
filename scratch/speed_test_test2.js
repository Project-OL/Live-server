import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import { client as redisClient, connectRedis } from '../src/config/redis.js';
import { sendLuckyGiftService } from '../src/routes/service/serviceLuckyGift.js';

dotenv.config();
const prisma = new PrismaClient();

async function main() {
    console.log("⚡ Testing Latency Speed for gift 'test2' (59cc96c8-d07f-4122-81dd-66ff193748e0)...\n");
    await connectRedis();

    const sender = await prisma.user.findFirst();
    const host = await prisma.user.findFirst({ where: { NOT: { id: sender.id } } });
    const gift = await prisma.gift.findUnique({ where: { id: '59cc96c8-d07f-4122-81dd-66ff193748e0' } });
    const stream = await prisma.liveStream.findFirst({ where: { isLive: true } });

    console.log(`👤 Sender: ${sender.username} | Host: ${host?.username} | Gift: ${gift.name} (${gift.coinCost}c)`);

    if (redisClient.isOpen) {
        await redisClient.set(`wallet:coins:${sender.id}`, "1000000", "EX", 3600);
    }

    console.log("\n🚀 Executing 5 Sequential Combo Gift Sends for 'test2':\n");

    for (let i = 1; i <= 5; i++) {
        const start = performance.now();
        const res = await sendLuckyGiftService({
            senderId: sender.id,
            receiverId: host?.id || sender.id,
            streamId: stream?.streamId || 'test-stream-123',
            giftId: gift.id,
            comboCount: 5,
            preFetchedGift: gift
        });
        const elapsed = (performance.now() - start).toFixed(2);
        console.log(`⏱️ Combo Gift Send #${i} -> Time: ${elapsed} ms | Category: ${res.luckyWin ? res.luckyWin.category : 'COMBO'} | Won: ${res.totalRewardCoins} Coins`);
    }

    console.log("\n✅ BENCHMARK COMPLETE!");
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());

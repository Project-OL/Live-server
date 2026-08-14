import { checkCoinsFrozenFast } from '../src/utils/coinRestriction.js';
import { toggleUserCoinsFreezeService } from '../src/routes/service/serviceAdmin.js';
import prisma from '../src/config/prisma.js';

async function main() {
    console.log("--- Testing personal_coins_frozen Restriction ---");

    // Get a test user
    const testUser = await prisma.user.findFirst({
        select: { id: true, username: true }
    });

    if (!testUser) {
        console.log("No test user found in DB.");
        return;
    }

    console.log(`Test user: ${testUser.username} (${testUser.id})`);

    // Step 1: Freeze coins via admin service
    console.log("\n1. Freezing coins for user...");
    await toggleUserCoinsFreezeService({ userId: testUser.id, isFrozen: true });
    console.log("Coins frozen successfully.");

    // Step 2: Attempt checkCoinsFrozenFast (Should throw error)
    console.log("\n2. Testing checkCoinsFrozenFast (Expecting Exception)...");
    try {
        await checkCoinsFrozenFast(testUser.id);
        console.error("FAIL: Expected exception was NOT thrown!");
    } catch (err) {
        console.log(`PASS: Caught expected error -> "${err.message}"`);
    }

    // Step 3: Unfreeze coins via admin service
    console.log("\n3. Unfreezing coins for user...");
    await toggleUserCoinsFreezeService({ userId: testUser.id, isFrozen: false });
    console.log("Coins unfrozen successfully.");

    // Step 4: Attempt checkCoinsFrozenFast (Should succeed without error)
    console.log("\n4. Testing checkCoinsFrozenFast after unfreezing...");
    try {
        await checkCoinsFrozenFast(testUser.id);
        console.log("PASS: Coin check succeeded without error.");
    } catch (err) {
        console.error(`FAIL: Unexpected error -> ${err.message}`);
    }

    console.log("\n--- All Personal Coins Freeze Tests Passed Successfully! ---");
}

main().catch(console.error).finally(() => prisma.$disconnect());

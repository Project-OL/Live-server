import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
dotenv.config();

const prisma = new PrismaClient();

async function main() {
    console.log("Checking for users in Database...");
    let users = await prisma.user.findMany({ take: 2 });
    
    // If not enough users, create them
    if (users.length < 2) {
        console.log("Creating dummy users for testing...");
        const publicId1 = Math.floor(Math.random() * 1000000000000);
        const publicId2 = Math.floor(Math.random() * 1000000000000);
        
        await prisma.user.createMany({
            data: [
                { username: "TestCaller", publicId: publicId1, defaultPublicId: publicId1 },
                { username: "TestReceiver", publicId: publicId2, defaultPublicId: publicId2 }
            ]
        });
        users = await prisma.user.findMany({ take: 2, orderBy: { createdAt: 'desc' } });
    }

    const userA = users[0];
    const userB = users[1];

    // Ensure VideoCallSettings exist for both
    for (const u of [userA, userB]) {
        const settings = await prisma.videoCallSettings.findUnique({ where: { userId: u.id } });
        if (!settings) {
            await prisma.videoCallSettings.create({
                data: {
                    userId: u.id,
                    pricePerMin: 1800
                }
            });
        }
    }

    // Generate JWT Tokens
    const secret = process.env.JWT_SECRET_KEY || process.env.JWT_SECRET || "fallback";
    
    const tokenA = jwt.sign({ userId: userA.id, tokenVersion: 0 }, secret, { expiresIn: '1d' });
    const tokenB = jwt.sign({ userId: userB.id, tokenVersion: 0 }, secret, { expiresIn: '1d' });

    console.log("\n==================================================");
    console.log("   🚀 COPY-PASTE THESE DETAILS FOR TESTING 🚀");
    console.log("==================================================\n");
    
    console.log("🟢 [USER A - CALLER]");
    console.log(`User ID : ${userA.id}`);
    console.log(`Token   : ${tokenA}\n`);
    
    console.log("🔵 [USER B - RECEIVER]");
    console.log(`User ID : ${userB.id}`);
    console.log(`Token   : ${tokenB}\n`);
    
    console.log("==================================================");
    console.log("✅ HOW TO TEST:");
    console.log("1. Open http://localhost:5000/test.html in Browser Tab 1");
    console.log("2. Open http://localhost:5000/test.html in Browser Tab 2");
    console.log("3. In Tab 1, enter [USER A] Token and User ID. In Target ID enter [USER B] User ID.");
    console.log("4. In Tab 2, enter [USER B] Token and User ID. (Target ID can be empty).");
    console.log("5. Click 'Connect' on both tabs.");
    console.log("6. Click 'Call' on Tab 1.");
    console.log("==================================================\n");
}

main().catch(console.error).finally(() => prisma.$disconnect());

/**
 * LIVE-52 part 2: helpers for the money concurrency tests.
 *
 * Runs Live-server's real money code against a THROWAWAY Postgres + Redis
 * (tests/money/docker-compose.yml). The environment is pinned here, before any app module is
 * imported, and the run refuses anything that is not the local test containers, so these tests
 * can never touch the shared dev RDS, staging or production.
 */
import crypto from "crypto";

const DB = process.env.MONEY_TEST_DATABASE_URL || "postgresql://money:money@127.0.0.1:55432/money_test";
const REDIS = process.env.MONEY_TEST_REDIS_URL || "redis://127.0.0.1:56379";

const host = new URL(DB.replace(/^postgresql:/, "http:"));
if (!["127.0.0.1", "localhost"].includes(host.hostname) || host.port !== "55432") {
    throw new Error(`Refusing to run money tests against ${host.hostname}:${host.port}; only the local test container is allowed.`);
}

// Set before the app's own dotenv.config() runs; dotenv never overrides existing variables.
Object.assign(process.env, {
    DATABASE_URL: `${DB}${DB.includes("?") ? "&" : "?"}connection_limit=40&pool_timeout=30`,
    REDIS_URL: REDIS,
    NODE_ENV: "test",
    IS_TEST: "1",
    LIVEKIT_URL: "http://127.0.0.1:1", // room deletes fail fast instead of reaching a real LiveKit
    LIVEKIT_API_KEY: "test-key",
    LIVEKIT_API_SECRET: "test-secret-test-secret-test-secret-00",
    OL_NODE_REST_BASE_URL: "",
});

export const { default: prisma } = await import("../../src/config/prisma.js");
const redis = await import("../../src/config/redis.js");
await redis.connectRedis();
export const videoCall = await import("../../src/modules/videoCall/service.js");
export const live = await import("../../src/routes/service/serviceLive.js");

const rid = () => crypto.randomBytes(6).toString("hex");
const randPublicId = () => BigInt(10_000_000 + Math.floor(Math.random() * 89_999_999));

export async function makeUser({ coins = 0n, agencyUserId = null } = {}) {
    const publicId = randPublicId();
    const user = await prisma.user.create({
        data: {
            username: `u_${rid()}`,
            publicId,
            defaultPublicId: publicId,
            ...(agencyUserId ? { currentAgencyId: agencyUserId } : {}),
        },
    });
    if (coins > 0n) {
        const wallet = await prisma.wallet.create({ data: { userId: user.id, currencyType: "COIN" } });
        await prisma.coinLedgerEntry.create({
            data: {
                walletId: wallet.id,
                direction: "CREDIT",
                txType: "TOPUP",
                amount: coins,
                balanceAfter: coins,
                idempotencyKey: `seed-${rid()}`,
            },
        });
    }
    return user;
}

/** Pre-create a user's COIN + POINT wallets (isolates locking tests from the LIVE-56 create race). */
export async function ensureWallets(userId) {
    for (const currencyType of ["COIN", "POINT"]) {
        await prisma.wallet.upsert({
            where: { userId_currencyType: { userId, currencyType } },
            create: { userId, currencyType },
            update: {},
        });
    }
}

export async function makeAgency(level = "A", rateBp = 1600) {
    await prisma.agencyCommissionLevel.upsert({
        where: { level },
        create: { level, minWindowPoints: 0n, liveRateBp: rateBp, matchChatRateBp: rateBp, sortOrder: 1 },
        update: { liveRateBp: rateBp, matchChatRateBp: rateBp },
    });
    const owner = await makeUser();
    await prisma.agency.create({
        data: { userId: owner.id, defaultPublicId: owner.publicId, displayName: `agency_${rid()}`, currentLevel: level },
    });
    return owner;
}

export async function makeGift(coinCost = 100) {
    return prisma.gift.create({
        data: { name: `gift_${rid()}`, coinCost, displayImageUrl: "https://example.invalid/g.png", code: `g_${rid()}`, isActive: true },
    });
}

export async function makeActiveCall(callerId, creatorId, pricePerMin = 600) {
    return prisma.videoCallSession.create({
        data: { callerId, creatorId, livekitRoom: `room_${rid()}`, pricePerMin, status: "ACTIVE", startedAt: new Date(), minsCharged: 1 },
    });
}

export async function walletIdOf(userId, currencyType) {
    const w = await prisma.wallet.findUnique({ where: { userId_currencyType: { userId, currencyType } } });
    return w?.id ?? null;
}

/**
 * Ledger invariants for the given wallets (same rule as the 2026-10-14 prod check):
 *  - every row's balanceAfter = previous balanceAfter ± amount (in created_at, id order)
 *  - the latest balanceAfter equals SUM(credits) - SUM(debits)
 * @returns {Promise<string[]>} problems, empty when consistent
 */
export async function ledgerProblems(walletIds) {
    const ids = walletIds.filter(Boolean);
    if (!ids.length) return [];
    const problems = [];
    for (const table of ["coin_ledger_entries", "point_ledger_entries"]) {
        const breaks = await prisma.$queryRawUnsafe(
            `WITH l AS (
               SELECT wallet_id, direction::text AS d, amount, balance_after,
                      LAG(balance_after) OVER (PARTITION BY wallet_id ORDER BY created_at, id) AS prev
               FROM ${table} WHERE wallet_id = ANY($1::uuid[]))
             SELECT wallet_id::text, count(*)::int AS n,
                    sum(prev + CASE WHEN d = 'CREDIT' THEN amount ELSE -amount END - balance_after)::text AS missing
             FROM l WHERE prev IS NOT NULL
               AND balance_after <> prev + CASE WHEN d = 'CREDIT' THEN amount ELSE -amount END
             GROUP BY wallet_id`,
            ids
        );
        for (const b of breaks) problems.push(`${table} wallet ${b.wallet_id}: ${b.n} chain break(s), ${b.missing} missing`);
        const sums = await prisma.$queryRawUnsafe(
            `SELECT wallet_id::text,
                    (sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END))::text AS ledger_sum,
                    (array_agg(balance_after ORDER BY created_at DESC, id DESC))[1]::text AS latest
             FROM ${table} WHERE wallet_id = ANY($1::uuid[]) GROUP BY wallet_id`,
            ids
        );
        for (const s of sums) {
            if (s.ledger_sum !== s.latest) {
                problems.push(`${table} wallet ${s.wallet_id}: stored balance ${s.latest} but ledger sum ${s.ledger_sum}`);
            }
        }
    }
    return problems;
}

/**
 * The ol-node-rest credit pattern (point-wallet.service creditInTransaction): lock the wallet row,
 * read the latest balance, append. Used to race Live-server code against "the other service".
 */
export async function olNodeStyleLockedCredit(userId, amount, currencyType = "POINT") {
    return prisma.$transaction(async (tx) => {
        const wallet = await tx.wallet.upsert({
            where: { userId_currencyType: { userId, currencyType } },
            create: { userId, currencyType },
            update: {},
        });
        await tx.$queryRaw`SELECT version FROM wallets WHERE id = ${wallet.id}::uuid FOR UPDATE`;
        const model = currencyType === "COIN" ? tx.coinLedgerEntry : tx.pointLedgerEntry;
        const last = await model.findFirst({ where: { walletId: wallet.id }, orderBy: { createdAt: "desc" }, select: { balanceAfter: true } });
        await model.create({
            data: {
                walletId: wallet.id,
                direction: "CREDIT",
                txType: "ADJUSTMENT",
                amount,
                balanceAfter: (last?.balanceAfter ?? 0n) + amount,
                idempotencyKey: `olnode-${rid()}`,
            },
        });
    });
}

export async function closeAll() {
    await prisma.$disconnect().catch(() => {});
    const { client } = redis;
    if (client.isOpen) await client.quit().catch(() => {});
}

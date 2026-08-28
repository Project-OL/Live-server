/**
 * Lift active live-stream moderation bans and clear related Redis caches.
 *
 * Run on EC2 (from Live-server root, with production .env loaded):
 *   node scripts/lift-live-moderation-bans.js
 *   node scripts/lift-live-moderation-bans.js --dry-run
 *   node scripts/lift-live-moderation-bans.js --verify-only
 *
 * Requires DATABASE_URL and REDIS_URL in the environment (or .env).
 *
 * Actions:
 *  1. users.suspended_until → NULL for users with a future host-stream suspension
 *  2. Soft-clear active user_restrictions rows of type LIVE_STREAM_START_BAN
 *  3. DELETE Redis keys user:suspended:* and user:restriction:*:LIVE_STREAM_START_BAN
 *  4. Verify configured user IDs — prints true/false per user (ban lifted or not)
 *
 * Does not delete host_stream_bans history rows (audit trail).
 */
import { PrismaClient } from '@prisma/client';
import { createClient } from 'redis';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');
const verifyOnly = process.argv.includes('--verify-only');
const SYSTEM_ADMIN_ID = '00000000-0000-0000-0000-000000000000';

/** Default users to verify after lift (override with VERIFY_USER_IDS=id1,id2). */
const DEFAULT_VERIFY_USER_IDS = [
  '10f2ea45-0089-4fea-a002-849057bb77fd',
  'f0b04639-084e-4185-9445-c5f7016a2f53',
];

function getVerifyUserIds() {
  const fromEnv = process.env.VERIFY_USER_IDS?.trim();
  if (fromEnv) {
    return fromEnv.split(',').map((id) => id.trim()).filter(Boolean);
  }
  return DEFAULT_VERIFY_USER_IDS;
}

async function connectRedisOptional(redisUrl) {
  if (!redisUrl) return null;

  const redis = createClient({
    url: redisUrl,
    socket: {
      connectTimeout: 10_000,
      reconnectStrategy: () => false,
    },
  });

  try {
    await redis.connect();
    return redis;
  } catch (err) {
    console.warn(`Redis connect failed (${err.message}) — DB-only verification will run`);
    try {
      await redis.disconnect();
    } catch {
      // ignore
    }
    return null;
  }
}

async function scanAndDelete(redis, pattern) {
  let deleted = 0;
  for await (const key of redis.scanIterator({ MATCH: pattern, COUNT: 500 })) {
    if (!dryRun) {
      await redis.del(key);
    }
    deleted += 1;
  }
  return deleted;
}

/**
 * Mirrors live-stream start ban checks (serviceLive + serviceAdmin).
 * Returns true when the user is NOT blocked from starting a live stream.
 */
async function isLiveStreamBanLifted(userId, redis, now) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, status: true, suspended_until: true },
  });

  if (!user) {
    return {
      lifted: false,
      reason: 'USER_NOT_FOUND',
      checks: { userExists: false },
    };
  }

  const dbSuspendedActive =
    user.suspended_until != null && user.suspended_until > now;

  const activeRestriction = await prisma.userRestriction.findFirst({
    where: {
      userId,
      type: 'LIVE_STREAM_START_BAN',
      clearedAt: null,
      restrictedUntil: { gt: now },
    },
    select: { id: true, restrictedUntil: true, reason: true },
  });

  let redisSuspendedActive = false;
  let redisSuspendedValue = null;
  let redisRestrictionActive = false;
  let redisRestrictionRaw = null;

  if (redis?.isOpen) {
    const suspendedKey = `user:suspended:${userId}`;
    const restrictionKey = `user:restriction:${userId}:LIVE_STREAM_START_BAN`;

    redisSuspendedValue = await redis.get(suspendedKey);
    redisSuspendedActive = redisSuspendedValue === 'true';

    redisRestrictionRaw = await redis.get(restrictionKey);
    if (redisRestrictionRaw) {
      try {
        const parsed = JSON.parse(redisRestrictionRaw);
        redisRestrictionActive =
          !parsed.clearedAt && new Date(parsed.restrictedUntil) > now;
      } catch {
        redisRestrictionActive = true;
      }
    }
  }

  const lifted =
    user.status === 'active' &&
    !dbSuspendedActive &&
    !activeRestriction &&
    !redisSuspendedActive &&
    !redisRestrictionActive;

  return {
    lifted,
    checks: {
      userExists: true,
      status: user.status,
      dbSuspendedUntil: user.suspended_until?.toISOString() ?? null,
      dbSuspendedActive,
      dbLiveStreamStartBan: activeRestriction
        ? {
            id: activeRestriction.id,
            until: activeRestriction.restrictedUntil.toISOString(),
            reason: activeRestriction.reason,
          }
        : null,
      redisSuspendedValue,
      redisSuspendedActive,
      redisRestrictionActive,
      redisRestrictionRaw: redisRestrictionRaw ? '(present)' : null,
    },
  };
}

async function runVerification(redis, userIds) {
  const now = new Date();
  console.log('\n=== Live-stream ban verification ===\n');

  const results = {};
  let allLifted = true;

  for (const userId of userIds) {
    const result = await isLiveStreamBanLifted(userId, redis, now);
    results[userId] = result.lifted;
    if (!result.lifted) allLifted = false;

    console.log(`${userId}: ${result.lifted}`);
    console.log(`  checks: ${JSON.stringify(result.checks, null, 2).replace(/\n/g, '\n  ')}`);
    console.log('');
  }

  console.log('Summary (true = ban lifted, can start live stream):');
  for (const [userId, lifted] of Object.entries(results)) {
    console.log(`  ${userId}: ${lifted}`);
  }
  console.log(`\nallLifted: ${allLifted}\n`);

  return allLifted;
}

async function main() {
  const now = new Date();
  const verifyUserIds = getVerifyUserIds();

  const redisUrl = process.env.REDIS_URL;
  const redis = await connectRedisOptional(redisUrl);
  if (!redisUrl) {
    console.warn('REDIS_URL not set — Redis cache checks/clears will be skipped');
  }

  if (!verifyOnly) {
    console.log(`\n=== Lift live moderation bans ${dryRun ? '(DRY RUN)' : ''} ===`);
    console.log(`Time: ${now.toISOString()}\n`);

    const suspendedUsers = await prisma.user.findMany({
      where: {
        suspended_until: { gt: now },
        status: 'active',
      },
      select: { id: true, suspended_until: true },
    });

    const activeBans = await prisma.userRestriction.findMany({
      where: {
        type: 'LIVE_STREAM_START_BAN',
        clearedAt: null,
        restrictedUntil: { gt: now },
      },
      select: { id: true, userId: true, restrictedUntil: true, reason: true },
    });

    console.log(`Users with active suspended_until: ${suspendedUsers.length}`);
    console.log(`Active LIVE_STREAM_START_BAN restrictions: ${activeBans.length}`);

    if (!dryRun) {
      const clearedSuspensions = await prisma.user.updateMany({
        where: {
          suspended_until: { gt: now },
          status: 'active',
        },
        data: { suspended_until: null },
      });

      const clearedRestrictions = await prisma.userRestriction.updateMany({
        where: {
          type: 'LIVE_STREAM_START_BAN',
          clearedAt: null,
          restrictedUntil: { gt: now },
        },
        data: {
          clearedAt: now,
          clearedByAdminId: SYSTEM_ADMIN_ID,
        },
      });

      console.log(`\nDB: cleared suspended_until on ${clearedSuspensions.count} user(s)`);
      console.log(`DB: soft-cleared ${clearedRestrictions.count} LIVE_STREAM_START_BAN restriction(s)`);
    } else {
      console.log('\n(dry-run) Would clear suspended_until and LIVE_STREAM_START_BAN restrictions listed above');
    }

    if (redis?.isOpen) {
      try {
        const suspendedKeys = await scanAndDelete(redis, 'user:suspended:*');
        const banKeys = await scanAndDelete(redis, 'user:restriction:*:LIVE_STREAM_START_BAN');

        console.log(
          `\nRedis: ${dryRun ? 'would delete' : 'deleted'} ${suspendedKeys} user:suspended:* key(s)`,
        );
        console.log(
          `Redis: ${dryRun ? 'would delete' : 'deleted'} ${banKeys} user:restriction:*:LIVE_STREAM_START_BAN key(s)`,
        );
      } catch (redisErr) {
        console.error('\nRedis cache clear failed:', redisErr.message);
        console.error('DB bans were cleared; re-run this script to finish Redis invalidation.');
      }
    }
  } else {
    console.log('\n=== Verify only (no lift) ===\n');
  }

  const allLifted = await runVerification(redis, verifyUserIds);

  if (redis?.isOpen) {
    await redis.quit();
  }

  if (!allLifted) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('Fatal:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

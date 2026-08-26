/**
 * Agency tier window + recompute (parity with ol-node
 * `agencyCommissionService.resolveTierWindowTotal` / `recomputeAgencyLevel` /
 * `afterCommissionCreditCommit`).
 *
 * Uses raw SQL for agency lock columns so recompute works even when the local
 * Prisma client is behind the shared DB schema (staging Live-server client).
 *
 * Live/VC gift paths must NOT write `currentLevel` from commission increments.
 * After a commission credit commits, call {@link afterCommissionCreditCommit}.
 */
import prisma from '../config/prisma.js'
import {
  effectiveTierWindowTotal,
  matchAgencyLevel,
} from '../utils/agencyTierLock.js'

function envFlagDefaultOn(name) {
  const v = process.env[name]
  return v !== 'false'
}

function envFlagDefaultOff(name) {
  return process.env[name] === 'true'
}

/** Avoid circular import with videoCall/service.js */
async function bustCaches(agencyUserId) {
  const { bustAgencyCommissionCaches } = await import('../modules/videoCall/service.js')
  await bustAgencyCommissionCaches(agencyUserId)
}

async function resolveRollingWindowBounds(now = new Date()) {
  let windowDays = 30
  let windowHours = 0
  let windowMinutes = 0
  try {
    const rows = await prisma.$queryRaw`
      SELECT window_days, window_hours, window_minutes
      FROM agency_commission_config
      WHERE id = 1
      LIMIT 1
    `
    if (rows[0]) {
      windowDays = Number(rows[0].window_days ?? 30)
      windowHours = Number(rows[0].window_hours ?? 0)
      windowMinutes = Number(rows[0].window_minutes ?? 0)
    }
  } catch (e) {
    console.warn('[AgencyTier] agency_commission_config read failed, using 30d default:', e.message)
  }
  const totalMinutes = Math.max(1, windowDays * 24 * 60 + windowHours * 60 + windowMinutes)
  const toExclusive = now
  const from = new Date(now.getTime() - totalMinutes * 60_000)
  return { from, toExclusive, totalMinutes }
}

async function sumHostEarningsLedgerWindow(agencyUserId, from, toExclusive) {
  const rows = await prisma.$queryRaw`
    WITH host_ids AS (
      SELECT ${agencyUserId}::uuid AS host_user_id
      UNION
      SELECT ah.host_user_id
      FROM agency_hosts ah
      WHERE ah.agency_user_id = ${agencyUserId}::uuid
      UNION
      SELECT h.host_user_id
      FROM agency_host_history h
      WHERE h.agency_user_id = ${agencyUserId}::uuid
        AND h.joined_at < ${toExclusive}
        AND h.exited_at > ${from}
    )
    SELECT COALESCE(SUM(ple.amount), 0)::bigint AS s
    FROM host_ids hid
    INNER JOIN wallets w
      ON w.user_id = hid.host_user_id
     AND w.currency_type = 'POINT'
    INNER JOIN users u ON u.id = w.user_id
    INNER JOIN point_ledger_entries ple
      ON ple.wallet_id = w.id
    INNER JOIN agency_commission_processed acp
      ON acp.host_ledger_entry_id = ple.id
    WHERE ple.direction = 'CREDIT'
      AND ple.tx_type IN ('GIFT_RECEIVE', 'LIVESTREAM_GIFT', 'VIDEO_CALL')
      AND ple.created_at >= ${from}
      AND ple.created_at < ${toExclusive}
      AND u.status NOT IN ('suspended', 'deleted')
      AND (
        EXISTS (
          SELECT 1
          FROM agency_hosts ah
          WHERE ah.agency_user_id = ${agencyUserId}::uuid
            AND ah.host_user_id = w.user_id
            AND ah.joined_at <= ple.created_at
        )
        OR EXISTS (
          SELECT 1
          FROM agency_host_history h
          WHERE h.agency_user_id = ${agencyUserId}::uuid
            AND h.host_user_id = w.user_id
            AND h.joined_at <= ple.created_at
            AND h.exited_at > ple.created_at
        )
        OR (
          w.user_id = ${agencyUserId}::uuid
          AND NOT EXISTS (
            SELECT 1
            FROM agency_hosts ah2
            WHERE ah2.host_user_id = w.user_id
              AND ah2.agency_user_id <> ${agencyUserId}::uuid
              AND ah2.joined_at <= ple.created_at
          )
          AND NOT EXISTS (
            SELECT 1
            FROM agency_host_history h2
            WHERE h2.host_user_id = w.user_id
              AND h2.agency_user_id <> ${agencyUserId}::uuid
              AND h2.joined_at <= ple.created_at
              AND h2.exited_at > ple.created_at
          )
        )
      )
  `
  return rows[0]?.s ?? 0n
}

async function sumAgencyCommissionLedgerWindow(agencyUserId, from, toExclusive) {
  const rows = await prisma.$queryRaw`
    SELECT COALESCE(SUM(ple.amount), 0)::bigint AS s
    FROM wallets w
    INNER JOIN point_ledger_entries ple ON ple.wallet_id = w.id
    WHERE w.user_id = ${agencyUserId}::uuid
      AND w.currency_type = 'POINT'
      AND ple.direction = 'CREDIT'
      AND ple.tx_type = 'AGENT_COMMISSION'
      AND ple.created_at >= ${from}
      AND ple.created_at < ${toExclusive}
      AND NOT EXISTS (
        SELECT 1
        FROM point_ledger_entries rev
        WHERE rev.wallet_id = w.id
          AND rev.direction = 'DEBIT'
          AND rev.tx_type = 'AGENT_COMMISSION'
          AND rev.idempotency_key = ('agency-commission-reverse:' || ple.id)
      )
  `
  return rows[0]?.s ?? 0n
}

export async function resolveTierWindowTotal(agencyUserId, opts = {}) {
  const now = opts.now ?? new Date()
  const { from, toExclusive, totalMinutes } = await resolveRollingWindowBounds(now)
  const includeHostEarnings = envFlagDefaultOn('AGENCY_TIER_INCLUDE_HOST_EARNINGS')
  const includeAgencyCommission = envFlagDefaultOff('AGENCY_TIER_INCLUDE_AGENCY_COMMISSION')

  let total = 0n
  if (includeHostEarnings) {
    total += await sumHostEarningsLedgerWindow(agencyUserId, from, toExclusive)
  }
  if (includeAgencyCommission) {
    total += await sumAgencyCommissionLedgerWindow(agencyUserId, from, toExclusive)
  }

  return {
    total,
    from,
    toExclusive,
    totalMinutes,
    includeHostEarnings,
    includeAgencyCommission,
  }
}

async function readAgencyLockRow(agencyUserId) {
  const rows = await prisma.$queryRaw`
    SELECT
      last_level_recomputed_at AS "lastLevelRecomputedAt",
      tier_lock_level AS "tierLockLevel",
      tier_lock_until AS "tierLockUntil",
      tier_lock_bonus_points AS "tierLockBonusPoints"
    FROM agencies
    WHERE user_id = ${agencyUserId}::uuid
    LIMIT 1
  `
  return rows[0] ?? null
}

/**
 * Refresh `currentLevel` + `currentWindowTotalPoints` from the rolling-window
 * metric, respecting an active admin tier lock (cannot drop below lock level).
 */
export async function recomputeAgencyLevel(agencyUserId, opts = {}) {
  if (!agencyUserId) return
  const MAX_CAS_ATTEMPTS = 5

  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
    const now = new Date()
    const cur = await readAgencyLockRow(agencyUserId)

    if (!opts.skipDailyDedupe) {
      if (cur?.lastLevelRecomputedAt) {
        const a = new Date(cur.lastLevelRecomputedAt).toISOString().slice(0, 10)
        const b = now.toISOString().slice(0, 10)
        if (a === b) return
      }
    }

    const { total: actual } = await resolveTierWindowTotal(agencyUserId, { now })
    const levels = await prisma.agencyCommissionLevel.findMany({
      orderBy: { minWindowPoints: 'asc' },
    })
    const lockLevelRow = cur?.tierLockLevel
      ? levels.find((l) => l.level === cur.tierLockLevel) ?? null
      : null
    const { effective, lockActive } = effectiveTierWindowTotal({
      actual,
      lock: {
        tierLockLevel: cur?.tierLockLevel ?? null,
        tierLockUntil: cur?.tierLockUntil ?? null,
        tierLockBonusPoints: cur?.tierLockBonusPoints ?? null,
      },
      lockLevelMinWindowPoints: lockLevelRow?.minWindowPoints ?? null,
      now,
    })
    const newLevel = matchAgencyLevel(effective, levels)

    // CAS on last_level_recomputed_at (NULL-safe)
    let count = 0
    if (cur?.lastLevelRecomputedAt == null) {
      if (lockActive) {
        const r = await prisma.$executeRaw`
          UPDATE agencies
          SET current_level = ${newLevel},
              current_window_total_points = ${actual},
              last_level_recomputed_at = ${now},
              updated_at = ${now}
          WHERE user_id = ${agencyUserId}::uuid
            AND last_level_recomputed_at IS NULL
        `
        count = Number(r)
      } else {
        const r = await prisma.$executeRaw`
          UPDATE agencies
          SET current_level = ${newLevel},
              current_window_total_points = ${actual},
              last_level_recomputed_at = ${now},
              tier_lock_level = NULL,
              tier_lock_until = NULL,
              tier_lock_bonus_points = NULL,
              updated_at = ${now}
          WHERE user_id = ${agencyUserId}::uuid
            AND last_level_recomputed_at IS NULL
        `
        count = Number(r)
      }
    } else {
      const prev = new Date(cur.lastLevelRecomputedAt)
      if (lockActive) {
        const r = await prisma.$executeRaw`
          UPDATE agencies
          SET current_level = ${newLevel},
              current_window_total_points = ${actual},
              last_level_recomputed_at = ${now},
              updated_at = ${now}
          WHERE user_id = ${agencyUserId}::uuid
            AND last_level_recomputed_at = ${prev}
        `
        count = Number(r)
      } else {
        const r = await prisma.$executeRaw`
          UPDATE agencies
          SET current_level = ${newLevel},
              current_window_total_points = ${actual},
              last_level_recomputed_at = ${now},
              tier_lock_level = NULL,
              tier_lock_until = NULL,
              tier_lock_bonus_points = NULL,
              updated_at = ${now}
          WHERE user_id = ${agencyUserId}::uuid
            AND last_level_recomputed_at = ${prev}
        `
        count = Number(r)
      }
    }

    if (count === 1) {
      await bustCaches(agencyUserId)
      return { currentLevel: newLevel, actualWindowTotalPoints: actual.toString() }
    }
  }

  console.warn(`[AgencyTier] recomputeAgencyLevel CAS exhausted for ${agencyUserId}`)
  return null
}

/**
 * Post-commit after agency commission credit: recompute tier (skip same-day
 * dedupe) and always bust commission caches.
 */
export async function afterCommissionCreditCommit(agencyUserId) {
  if (!agencyUserId) return
  try {
    await recomputeAgencyLevel(agencyUserId, { skipDailyDedupe: true })
  } finally {
    await bustCaches(agencyUserId)
  }
}

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
  higherLevel,
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
  // Parity with ol-node resolveAgencyCommissionRollingWindowBounds: whole-day windows are
  // anchored to UTC midnight (start only moves at 00:00 UTC, so within a day the total only
  // grows); windows with an hours/minutes part (short QA windows) stay exact [now − d, now).
  const toExclusive = now
  const anchor = totalMinutes % (24 * 60) === 0 ? utcStartOfDay(now) : now
  const from = new Date(anchor.getTime() - totalMinutes * 60_000)
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
      current_level AS "currentLevel",
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

const utcDay = (d) => new Date(d).toISOString().slice(0, 10)

/** Midnight UTC for the given instant's calendar date. */
function utcStartOfDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/**
 * Daily level evaluation (parity with ol-node `agencyCommissionService.recomputeAgencyLevel`).
 * The tier window starts at 00:00 UTC `duration` back and runs to now, so within a day it
 * only grows: the level can rise mid-day ({@link refreshWindowProgress}) and only falls
 * here, when the oldest day leaves the window. Result = higher of the level on the
 * completed-days window (ending today 00:00 UTC) and on the window so far, respecting an
 * admin tier lock active at 00:00. `currentWindowTotalPoints` stores the window-so-far total.
 */
export async function recomputeAgencyLevel(agencyUserId, opts = {}) {
  if (!agencyUserId) return
  const MAX_CAS_ATTEMPTS = 5

  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
    const now = new Date()
    const evaluatedAt = utcStartOfDay(now)
    const cur = await readAgencyLockRow(agencyUserId)

    if (!opts.skipDailyDedupe) {
      if (cur?.lastLevelRecomputedAt && utcDay(cur.lastLevelRecomputedAt) === utcDay(now)) return
    }

    const [{ total: atDayStart }, { total: actual }] = await Promise.all([
      resolveTierWindowTotal(agencyUserId, { now: evaluatedAt }),
      resolveTierWindowTotal(agencyUserId, { now }),
    ])
    const levels = await prisma.agencyCommissionLevel.findMany({
      orderBy: { minWindowPoints: 'asc' },
    })
    const lockLevelRow = cur?.tierLockLevel
      ? levels.find((l) => l.level === cur.tierLockLevel) ?? null
      : null
    const lock = {
      tierLockLevel: cur?.tierLockLevel ?? null,
      tierLockUntil: cur?.tierLockUntil ?? null,
      tierLockBonusPoints: cur?.tierLockBonusPoints ?? null,
    }
    const lockLevelMinWindowPoints = lockLevelRow?.minWindowPoints ?? null
    const atDayStartEff = effectiveTierWindowTotal({
      actual: atDayStart,
      lock,
      lockLevelMinWindowPoints,
      now: evaluatedAt,
    })
    const liveEff = effectiveTierWindowTotal({ actual, lock, lockLevelMinWindowPoints, now })
    const lockActive = atDayStartEff.lockActive
    const newLevel = higherLevel(
      matchAgencyLevel(atDayStartEff.effective, levels),
      matchAgencyLevel(liveEff.effective, levels),
      levels,
    )

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
 * After a credit: refresh `current_window_total_points` and **raise** the level if the
 * window so far now reaches a higher tier (parity with ol-node `refreshWindowProgress`).
 * Never lowers it. If the level hasn't been evaluated yet today (nightly job
 * late/disabled), run the daily evaluation instead.
 */
export async function refreshWindowProgress(agencyUserId) {
  if (!agencyUserId) return
  const now = new Date()
  const cur = await readAgencyLockRow(agencyUserId)
  if (!cur) return
  if (!cur.lastLevelRecomputedAt || utcDay(cur.lastLevelRecomputedAt) !== utcDay(now)) {
    await recomputeAgencyLevel(agencyUserId)
    return
  }
  const { total } = await resolveTierWindowTotal(agencyUserId, { now })
  const levels = await prisma.agencyCommissionLevel.findMany({
    orderBy: { minWindowPoints: 'asc' },
  })
  const lockLevelRow = cur.tierLockLevel
    ? levels.find((l) => l.level === cur.tierLockLevel) ?? null
    : null
  const { effective } = effectiveTierWindowTotal({
    actual: total,
    lock: {
      tierLockLevel: cur.tierLockLevel ?? null,
      tierLockUntil: cur.tierLockUntil ?? null,
      tierLockBonusPoints: cur.tierLockBonusPoints ?? null,
    },
    lockLevelMinWindowPoints: lockLevelRow?.minWindowPoints ?? null,
    now,
  })
  const reached = matchAgencyLevel(effective, levels)
  if (higherLevel(reached, cur.currentLevel, levels) !== cur.currentLevel) {
    // Conditional on the level we read, so a concurrent upgrade/evaluation isn't overwritten.
    const r = await prisma.$executeRaw`
      UPDATE agencies
      SET current_level = ${reached},
          current_window_total_points = ${total},
          updated_at = ${now}
      WHERE user_id = ${agencyUserId}::uuid
        AND current_level = ${cur.currentLevel}
    `
    if (Number(r) === 1) return
  }
  await prisma.$executeRaw`
    UPDATE agencies
    SET current_window_total_points = ${total},
        updated_at = ${now}
    WHERE user_id = ${agencyUserId}::uuid
  `
}

/**
 * Post-commit after agency commission credit: refresh the window total, raise the
 * level if a higher tier was reached (never lower mid-day), and always bust caches.
 */
export async function afterCommissionCreditCommit(agencyUserId) {
  if (!agencyUserId) return
  try {
    await refreshWindowProgress(agencyUserId)
  } finally {
    await bustCaches(agencyUserId)
  }
}

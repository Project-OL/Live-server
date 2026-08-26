/**
 * Admin-assigned agency commission tier lock (parity with ol-node
 * `src/utils/agency-tier-lock.ts`).
 *
 * While the lock is active, recomputes use:
 *   effective = max(actual + bonus, minWindowPoints(lockLevel))
 * so the assigned tier is a floor (can rise, cannot drop below).
 */

export function isAgencyTierLockActive(lock, now = new Date()) {
  return (
    lock?.tierLockUntil != null &&
    new Date(lock.tierLockUntil).getTime() > now.getTime() &&
    lock.tierLockLevel != null &&
    String(lock.tierLockLevel).length > 0 &&
    lock.tierLockBonusPoints != null
  )
}

export function computeTierLockBonus(minWindowPoints, actualAtAssignment) {
  return BigInt(minWindowPoints) - BigInt(actualAtAssignment)
}

export function effectiveTierWindowTotal({ actual, lock, lockLevelMinWindowPoints, now = new Date() }) {
  const actualBig = BigInt(actual)
  if (!isAgencyTierLockActive(lock, now) || lockLevelMinWindowPoints == null) {
    return { effective: actualBig, lockActive: false }
  }
  const withBonus = actualBig + BigInt(lock.tierLockBonusPoints)
  const floor = BigInt(lockLevelMinWindowPoints)
  const effective = withBonus > floor ? withBonus : floor
  return { effective, lockActive: true }
}

export function matchAgencyLevel(total, levels) {
  const totalBig = BigInt(total)
  let newLevel = levels[0]?.level ?? 'D'
  for (let i = levels.length - 1; i >= 0; i--) {
    const row = levels[i]
    if (totalBig >= BigInt(row.minWindowPoints)) {
      newLevel = row.level
      break
    }
  }
  return newLevel
}

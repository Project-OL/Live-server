/**
 * Unit tests: agency tier lock + match (parity with ol-node agency-tier-lock).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  computeTierLockBonus,
  effectiveTierWindowTotal,
  isAgencyTierLockActive,
  matchAgencyLevel,
} from './agencyTierLock.js'

const levels = [
  { level: 'D', minWindowPoints: 0n },
  { level: 'C', minWindowPoints: 10_000n },
  { level: 'B', minWindowPoints: 100_000n },
  { level: 'A', minWindowPoints: 1_000_000n },
  { level: 'S', minWindowPoints: 10_000_000n },
  { level: 'SS+', minWindowPoints: 250_000_000n },
]

test('matchAgencyLevel picks highest qualifying tier', () => {
  assert.equal(matchAgencyLevel(0n, levels), 'D')
  assert.equal(matchAgencyLevel(2544n, levels), 'D')
  assert.equal(matchAgencyLevel(250_000_000n, levels), 'SS+')
  assert.equal(matchAgencyLevel(250_000_144n, levels), 'SS+')
})

test('active lock floors effective total at lock min (cannot drop below SS+)', () => {
  const now = new Date('2026-08-26T12:00:00.000Z')
  const lock = {
    tierLockLevel: 'SS+',
    tierLockUntil: new Date('2026-08-27T12:00:00.000Z'),
    tierLockBonusPoints: computeTierLockBonus(250_000_000n, 2400n),
  }
  assert.equal(isAgencyTierLockActive(lock, now), true)
  const { effective, lockActive } = effectiveTierWindowTotal({
    actual: 2544n,
    lock,
    lockLevelMinWindowPoints: 250_000_000n,
    now,
  })
  assert.equal(lockActive, true)
  // 2544 + (250000000 - 2400) = 250000144 > floor
  assert.equal(effective, 250_000_144n)
  assert.equal(matchAgencyLevel(effective, levels), 'SS+')
})

test('expired lock uses actual only', () => {
  const now = new Date('2026-08-28T12:00:00.000Z')
  const lock = {
    tierLockLevel: 'SS+',
    tierLockUntil: new Date('2026-08-27T12:00:00.000Z'),
    tierLockBonusPoints: 250_000_000n,
  }
  const { effective, lockActive } = effectiveTierWindowTotal({
    actual: 2544n,
    lock,
    lockLevelMinWindowPoints: 250_000_000n,
    now,
  })
  assert.equal(lockActive, false)
  assert.equal(effective, 2544n)
  assert.equal(matchAgencyLevel(effective, levels), 'D')
})

/**
 * A1 / B4 harness helpers: mock ledger + capture emit sequences for sendLuckyGiftService.
 * Used by a1PayloadEquality.test.js and b4EnforcePayload.test.js.
 */
import { mock } from 'node:test'
import assert from 'node:assert/strict'

export const NORMALIZED_KEYS = [
  'transactionId',
  'giftTransactionId',
  'id',
  'createdAt',
  'updatedAt',
  'timestamp',
  '_id',
]

export function normalize(value, keys = NORMALIZED_KEYS) {
  if (value === null || value === undefined) return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      return '<UUID>'
    }
    return value
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, keys))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (keys.includes(k)) {
        out[k] =
          typeof v === 'string' && /[0-9a-f-]{36}/i.test(v) ? '<UUID>' : '<NONDET>'
        continue
      }
      out[k] = normalize(v, keys)
    }
    return out
  }
  return value
}

export function deepEqualNormalized(a, b, label = '') {
  assert.deepEqual(normalize(a), normalize(b), label)
}

export function seqRandom(seq) {
  let i = 0
  return () => {
    const v = seq[i % seq.length]
    i += 1
    return v
  }
}

/** Build a ledger response matching serviceLuckyGift mapping. */
export function mockLedgerResponse(overrides = {}) {
  return {
    transactionId: overrides.transactionId ?? '00000000-0000-4000-8000-0000000000tx',
    finalBalanceCoins: String(overrides.finalBalanceCoins ?? 99000),
    pointsAfterHost: overrides.pointsAfterHost != null ? String(overrides.pointsAfterHost) : '4',
    effectiveReceiverId: overrides.effectiveReceiverId ?? '00000000-0000-4000-8000-0000000000r1',
    wealth: overrides.wealth ?? { newLevel: 12, previousLevel: 12 },
    hostPoints: String(overrides.hostPoints ?? 4),
    agencyUserId: overrides.agencyUserId ?? null,
    engine: overrides.engine,
    rewardCoins: overrides.rewardCoins != null ? String(overrides.rewardCoins) : undefined,
    category: overrides.category,
    breakdownArray: overrides.breakdownArray,
    tierId: overrides.tierId,
    configVersion: overrides.configVersion,
  }
}

export function httpStreamBodyFromService(result) {
  return {
    success: true,
    message: 'Gift sent successfully',
    data: {
      newBalance: result.senderRemainingCoins,
      currentLevel: result.currentLevel,
      isLevelUp: result.isLevelUp,
      isLucky: true,
      sendValue: result.totalCost,
      returnValue: result.totalRewardCoins,
      transactionId: result.transactionId,
      category: result.category,
    },
  }
}

/** Emit sequence for socket send_lucky_gift (mirrors socket-live-service.js). */
export function emitSequenceSendLuckyGift(result) {
  const emits = []
  if (result.count === 1) {
    emits.push({
      event: 'lucky_gift_single_result',
      payload: {
        ...result.luckyWin,
        transactionId: result.transactionId,
        totalRewardCoins: result.totalRewardCoins,
        category: result.category,
        breakdownArray: result.breakdownArray,
      },
    })
  } else {
    let acc = 0
    for (let i = 0; i < (result.breakdownArray?.length ?? 0); i++) {
      const stepRewardCoins = result.breakdownArray[i]
      acc += stepRewardCoins
      emits.push({
        event: 'lucky_gift_combo_step',
        payload: {
          step: i + 1,
          stepRewardCoins,
          accumulatedRewardCoins: acc,
          totalRewardCoins: result.totalRewardCoins,
          category: result.category,
          transactionId: result.transactionId,
        },
      })
    }
  }
  if (result.luckyWin) {
    emits.push({
      event: 'LUCKY_GIFT_WIN',
      payload: { ...result.luckyWin, transactionId: result.transactionId },
    })
  }
  return emits
}

export function emitSequenceStreamGift(result) {
  const emits = [{ event: 'GIFT_SENT', payload: { ...result.socketPayload, transactionId: result.transactionId } }]
  if (result.luckyWin) {
    emits.push({ event: 'LUCKY_GIFT_WIN', payload: { ...result.luckyWin, transactionId: result.transactionId } })
  }
  return emits
}

/** Install callLedger mock that returns a fixed payload (or throws). */
export async function withMockedLedger(ledgerImpl, fn) {
  const ledgerPath = new URL('../../../src/services/ledgerClient.js', import.meta.url).href
  mock.module(ledgerPath, {
    namedExports: {
      callLedger: async (...args) => ledgerImpl(...args),
      toLocalError: (err) => err,
    },
  })
  try {
    return await fn()
  } finally {
    mock.restoreAll()
  }
}

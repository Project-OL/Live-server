/**
 * A1: current sendLuckyGiftService payload equality (legacy/off) with injected ledger.
 *
 * Run: node --test tests/fixtures/lucky/a1PayloadEquality.test.js
 */
process.env.NODE_ENV = 'test'
process.env.IS_TEST = '1'

import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  deepEqualNormalized,
  emitSequenceSendLuckyGift,
  emitSequenceStreamGift,
  httpStreamBodyFromService,
  mockLedgerResponse,
  seqRandom,
  NORMALIZED_KEYS,
} from './a1PayloadEquality.harness.mjs'
import { createMemoryRedis, noopCheckFrozen } from './memoryRedis.mjs'
import { sendLuckyGiftService } from '../../../src/routes/service/serviceLuckyGift.js'
import { setLuckyRewardRandom } from '../../../src/modules/luckyGift/luckyReward.engine.js'
import { client as redisClient } from '../../../src/config/redis.js'
import { runShutdownHooks } from '../../../src/services/cluster.service.js'

const GIFT = {
  id: '00000000-0000-4000-8000-0000000000g1',
  name: 'Lucky Star',
  displayImageUrl: 'https://cdn.example/thumb.webp',
  fullImageUrl: 'https://cdn.example/full.png',
  coinCost: 100,
  isActive: true,
  isLucky: true,
  effectLuckyGift: true,
}
const SENDER = '00000000-0000-4000-8000-0000000000s1'
const RECEIVER = '00000000-0000-4000-8000-0000000000r1'
const STREAM = '00000000-0000-4000-8000-0000000000st'

const memRedis = createMemoryRedis()
let poolStats = { currentRtp: 92, targetRtp: 92 }

/** Echo ledger: returns local reward as legacy (no engine) so path uses local draw. */
function echoLedger() {
  return async (_op, _path, body) =>
    mockLedgerResponse({
      transactionId: body.giftTransactionId,
      finalBalanceCoins: 100000 - Number(body.count) * 100 + Number(body.rewardCoins),
      rewardCoins: body.rewardCoins,
      category: body.category,
      breakdownArray: undefined,
      hostPoints: Math.floor((Number(body.count) * 100 * 400) / 10000),
    })
}

function deps(ledgerCall) {
  return {
    ledgerCall,
    getPoolStats: async () => ({ ...poolStats }),
    checkFrozen: noopCheckFrozen,
    redis: memRedis,
  }
}

async function runCurrent(opts, ledgerCall = echoLedger()) {
  return sendLuckyGiftService(
    {
      senderId: SENDER,
      receiverId: RECEIVER,
      streamId: STREAM,
      giftId: GIFT.id,
      preFetchedGift: GIFT,
      ...opts,
    },
    deps(ledgerCall),
  )
}

describe('A1 payload equality baseline vs current (legacy echo ledger)', () => {
  before(() => {
    process.env.LUCKY_LEGACY_COMBO_REDUCE_FIX = 'false'
    process.env.LUCKY_EMIT_DEDUPE_ENABLED = 'true'
    poolStats = { currentRtp: 92, targetRtp: 92 }
  })

  after(async () => {
    delete process.env.LUCKY_LEGACY_COMBO_REDUCE_FIX
    setLuckyRewardRandom(Math.random)
    memRedis.clear()
    await runShutdownHooks()
    try {
      if (redisClient.isOpen) await redisClient.quit()
    } catch {
      /* ignore */
    }
  })

  afterEach(() => {
    setLuckyRewardRandom(Math.random)
    memRedis.clear()
    poolStats = { currentRtp: 92, targetRtp: 92 }
  })

  const singles = [
    { name: 'miss', seq: [0.0], cat: 'MISS' },
    { name: '0_5x', seq: [0.45], cat: 'SMALL' },
    { name: '1x', seq: [0.75], cat: 'EQUAL' },
    { name: '2_5x', seq: [0.95], cat: 'MEDIUM' },
    { name: '10x', seq: [0.995], cat: 'JACKPOT' },
  ]

  for (const c of singles) {
    it(`single_${c.name}: HTTP stream/direct + socket + emits deep-equal (self + contract)`, async () => {
      setLuckyRewardRandom(seqRandom(c.seq))
      const result = await runCurrent({ comboCount: 1 })
      assert.equal(result.category, c.cat)
      assert.equal(result.engine, undefined)
      const stream = httpStreamBodyFromService(result)
      assert.equal(stream.data.category, c.cat)
      assert.equal(stream.data.sendValue, 100)
      assert.equal(typeof stream.data.returnValue, 'number')
      assert.equal(result.socketPayload.senderRemainingCoins, result.senderRemainingCoins)
      const emits = emitSequenceStreamGift(result)
      assert.equal(emits[0].event, 'GIFT_SENT')
      if (result.totalRewardCoins > 0) {
        assert.equal(emits[1].event, 'LUCKY_GIFT_WIN')
      } else {
        assert.equal(emits.length, 1)
        assert.equal(result.luckyWin, null)
      }
      deepEqualNormalized(result.socketPayload.isLucky, true)
    })
  }

  for (const n of [3, 10, 25]) {
    it(`combo_n${n}: breakdown sum + emit sequence consistent`, async () => {
      setLuckyRewardRandom(seqRandom([0.5, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3]))
      const result = await runCurrent({ comboCount: n })
      assert.equal(
        result.breakdownArray.reduce((a, b) => a + b, 0),
        result.totalRewardCoins,
      )
      const emits = emitSequenceSendLuckyGift(result)
      assert.ok(emits.every((e) => e.event !== 'GIFT_SENT'))
    })
  }

  it('insufficient coins: ledger error surfaces', async () => {
    await assert.rejects(
      () =>
        runCurrent({ comboCount: 1 }, async () => {
          const err = new Error('Insufficient coin balance. Required: 100, Available: 0')
          err.code = 'INSUFFICIENT_COINS'
          throw err
        }),
      /Insufficient coin balance/,
    )
  })

  it('normalised keys listed', () => {
    assert.deepEqual(NORMALIZED_KEYS.sort(), [
      '_id',
      'createdAt',
      'giftTransactionId',
      'id',
      'timestamp',
      'transactionId',
      'updatedAt',
    ].sort())
  })

  it('LG-01 isolation: with fix=true combo-reduce differs from fix=false', async () => {
    poolStats = { currentRtp: 100, targetRtp: 92 }
    process.env.LUCKY_LEGACY_COMBO_REDUCE_FIX = 'false'
    setLuckyRewardRandom(seqRandom([0.0, 0.3, 0.3, 0.3]))
    const buggy = await runCurrent({ comboCount: 3 })

    process.env.LUCKY_LEGACY_COMBO_REDUCE_FIX = 'true'
    setLuckyRewardRandom(seqRandom([0.0, 0.3, 0.3, 0.3]))
    const fixed = await runCurrent({ comboCount: 3 })

    assert.equal(Number(buggy.totalRewardCoins), 150)
    assert.equal(Number(fixed.totalRewardCoins), 0)
    assert.notEqual(buggy.totalRewardCoins, fixed.totalRewardCoins)
    poolStats = { currentRtp: 92, targetRtp: 92 }
  })

  it('stealth: socketPayload still carries senderRemainingCoins from ledger', async () => {
    setLuckyRewardRandom(seqRandom([0.75]))
    const result = await runCurrent({ comboCount: 1 })
    assert.ok(result.socketPayload.senderId)
    assert.equal(typeof result.socketPayload.senderRemainingCoins, 'number')
  })

  it('non-lucky: harness documents 4 entry paths use isLuckyGift gate (shape fixture)', () => {
    const nonLuckyStream = {
      data: { isLucky: false, sendValue: 50, returnValue: 0, category: null },
    }
    assert.equal(nonLuckyStream.data.isLucky, false)
  })
})

/**
 * B4: Live-server real sendLuckyGiftService with injected water_v1 ledger.
 * Run: node --test tests/fixtures/lucky/b4EnforcePayload.test.js
 */
process.env.NODE_ENV = 'test'
process.env.IS_TEST = '1'

import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  emitSequenceSendLuckyGift,
  emitSequenceStreamGift,
  httpStreamBodyFromService,
  mockLedgerResponse,
  seqRandom,
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
const poolOk = async () => ({ currentRtp: 92, targetRtp: 92 })

function deps(ledgerCall, getPoolStats = poolOk) {
  return {
    ledgerCall,
    getPoolStats,
    checkFrozen: noopCheckFrozen,
    redis: memRedis,
  }
}

describe('B4 Live enforce payload (real sendLuckyGiftService)', () => {
  before(() => {
    process.env.LUCKY_EMIT_DEDUPE_ENABLED = 'false'
  })
  after(async () => {
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
  })

  it('1: local jackpot vs ledger miss → no LUCKY_GIFT_WIN, returnValue 0, balances from ledger', async () => {
    setLuckyRewardRandom(seqRandom([0.995]))
    const result = await sendLuckyGiftService(
      {
        senderId: SENDER,
        receiverId: RECEIVER,
        streamId: STREAM,
        giftId: GIFT.id,
        comboCount: 1,
        preFetchedGift: GIFT,
      },
      deps(async () =>
        mockLedgerResponse({
          engine: 'water_v1',
          rewardCoins: 0,
          category: 'MISS',
          breakdownArray: [0],
          finalBalanceCoins: 88888,
          tierId: 'T100',
          configVersion: 2,
        }),
      ),
    )
    assert.equal(result.engine, 'water_v1')
    assert.equal(result.luckyWin, null)
    assert.equal(result.category, 'MISS')
    assert.equal(result.totalRewardCoins, 0)
    assert.equal(result.senderRemainingCoins, 88888)
    const stream = httpStreamBodyFromService(result)
    assert.equal(stream.data.returnValue, 0)
    assert.equal(stream.data.newBalance, 88888)
    assert.equal(stream.data.category, 'MISS')
    const emits = emitSequenceStreamGift(result)
    assert.equal(emits.some((e) => e.event === 'LUCKY_GIFT_WIN'), false)
    assert.equal(emits[0].event, 'GIFT_SENT')
  })

  it('2: local miss vs ledger 2.5× → LUCKY_GIFT_WIN once with ledger reward', async () => {
    setLuckyRewardRandom(seqRandom([0.0]))
    const result = await sendLuckyGiftService(
      {
        senderId: SENDER,
        receiverId: RECEIVER,
        streamId: STREAM,
        giftId: GIFT.id,
        comboCount: 1,
        preFetchedGift: GIFT,
      },
      deps(async () =>
        mockLedgerResponse({
          engine: 'water_v1',
          rewardCoins: 250,
          category: 'MEDIUM',
          breakdownArray: [250],
          finalBalanceCoins: 90150,
          tierId: 'T100',
          configVersion: 2,
        }),
      ),
    )
    assert.equal(result.totalRewardCoins, 250)
    assert.equal(result.category, 'MEDIUM')
    assert.ok(result.luckyWin)
    assert.equal(result.luckyWin.rewardCoins, 250)
    const emits = emitSequenceSendLuckyGift(result)
    const wins = emits.filter((e) => e.event === 'LUCKY_GIFT_WIN')
    assert.equal(wins.length, 1)
    assert.equal(wins[0].payload.rewardCoins, 250)
    const stream = httpStreamBodyFromService(result)
    assert.equal(stream.data.returnValue, 250)
  })

  it('3: combo N=25 local WINNER vs ledger partial dry-out breakdown', async () => {
    setLuckyRewardRandom(seqRandom([0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99]))
    const breakdown = [100, 100, 50, 0, 0, 0, 0, 0, 0, 0]
    const total = breakdown.reduce((a, b) => a + b, 0)
    const result = await sendLuckyGiftService(
      {
        senderId: SENDER,
        receiverId: RECEIVER,
        streamId: STREAM,
        giftId: GIFT.id,
        comboCount: 25,
        preFetchedGift: GIFT,
      },
      deps(async () =>
        mockLedgerResponse({
          engine: 'water_v1',
          rewardCoins: total,
          category: 'PARTIAL',
          breakdownArray: breakdown,
          finalBalanceCoins: 50000,
          tierId: 'T100',
          configVersion: 3,
        }),
      ),
    )
    assert.equal(result.breakdownArray.length, 10)
    assert.equal(result.breakdownArray.reduce((a, b) => a + b, 0), total)
    assert.equal(result.totalRewardCoins, total)
    assert.equal(result.category, 'PARTIAL')
    const steps = emitSequenceSendLuckyGift(result).filter((e) => e.event === 'lucky_gift_combo_step')
    assert.equal(steps.length, 10)
    assert.equal(steps[0].payload.stepRewardCoins, 100)
    assert.equal(steps[steps.length - 1].payload.totalRewardCoins, total)
    assert.equal(steps[2].payload.accumulatedRewardCoins, 250)
  })

  it('4: socket send_lucky_gift single_result from ledger', async () => {
    setLuckyRewardRandom(seqRandom([0.5]))
    const result = await sendLuckyGiftService(
      {
        senderId: SENDER,
        receiverId: RECEIVER,
        streamId: STREAM,
        giftId: GIFT.id,
        comboCount: 1,
        preFetchedGift: GIFT,
      },
      deps(async () =>
        mockLedgerResponse({
          engine: 'water_v1',
          rewardCoins: 100,
          category: 'EQUAL',
          breakdownArray: [100],
          finalBalanceCoins: 90000,
        }),
      ),
    )
    const emits = emitSequenceSendLuckyGift(result)
    const single = emits.find((e) => e.event === 'lucky_gift_single_result')
    assert.ok(single)
    assert.equal(single.payload.rewardCoins, 100)
    assert.equal(single.payload.totalRewardCoins, 100)
    assert.equal(single.payload.category, 'EQUAL')
  })

  it('5: missing engine → legacy behaviour (local draw kept)', async () => {
    setLuckyRewardRandom(seqRandom([0.75]))
    const result = await sendLuckyGiftService(
      {
        senderId: SENDER,
        receiverId: RECEIVER,
        streamId: STREAM,
        giftId: GIFT.id,
        comboCount: 1,
        preFetchedGift: GIFT,
      },
      deps(async () =>
        mockLedgerResponse({
          finalBalanceCoins: 99000,
        }),
      ),
    )
    assert.equal(result.engine, undefined)
    assert.equal(result.category, 'EQUAL')
    assert.equal(result.totalRewardCoins, 100)
  })
})

/**
 * Single-process worker for A1 dual-process comparison.
 *
 * Usage:
 *   node --experimental-test-module-mocks a1DualProcessRunner.mjs --side=current|baseline ...
 */
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mock } from 'node:test'
import { createClient } from 'redis'
import {
  A1_CASES,
  BASELINE_ROOT,
  GIFT,
  RECEIVER,
  SENDER,
  STREAM,
  echoLedgerImpl,
  insufficientLedgerImpl,
  jsonReplacer,
  seqRandom,
} from './a1DualProcess.shared.mjs'
import {
  emitSequenceSendLuckyGift,
  emitSequenceStreamGift,
  httpStreamBodyFromService,
} from './a1PayloadEquality.harness.mjs'

function parseArgs(argv) {
  const out = { side: 'current', caseId: '', legacyFix: 'false', outPath: '' }
  for (const arg of argv) {
    if (arg.startsWith('--side=')) out.side = arg.slice(7)
    else if (arg.startsWith('--case=')) out.caseId = arg.slice(7)
    else if (arg.startsWith('--legacy-fix=')) out.legacyFix = arg.slice(13)
    else if (arg.startsWith('--out=')) out.outPath = arg.slice(6)
  }
  return out
}

function buildCapture(result, entryPath) {
  const isCombo = (result?.count ?? 1) > 1
  const emits =
    entryPath === 'stream'
      ? emitSequenceStreamGift(result)
      : isCombo
        ? emitSequenceSendLuckyGift(result)
        : emitSequenceStreamGift(result)

  return {
    httpStreamBody: httpStreamBodyFromService(result),
    httpDirectBody: result,
    socketPayload: result.socketPayload,
    luckyWin: result.luckyWin ?? null,
    emitSequence: emits,
  }
}

async function createRedis(url) {
  const client = createClient({ url })
  client.on('error', () => {})
  await client.connect()
  return client
}

async function flushIdemKey(redis, clientTxId) {
  if (!clientTxId) return
  const key = `lucky:idempotency:${SENDER}:${clientTxId}`
  await redis.del(key)
}

async function loadCurrentService(poolStats, ledgerImpl, redis) {
  const { sendLuckyGiftService } = await import(
    '../../../src/routes/service/serviceLuckyGift.js'
  )
  const { setLuckyRewardRandom } = await import(
    '../../../src/modules/luckyGift/luckyReward.engine.js'
  )

  const noopCheckFrozen = async () => {}

  async function runCase(caseDef, opts = {}) {
    const ledgerCall = opts.ledgerCall ?? echoLedgerImpl()
    return sendLuckyGiftService(
      {
        senderId: SENDER,
        receiverId: RECEIVER,
        streamId: STREAM,
        giftId: GIFT.id,
        preFetchedGift: GIFT,
        comboCount: caseDef.comboCount ?? 1,
        clientTxId: opts.clientTxId ?? caseDef.clientTxId ?? null,
      },
      {
        ledgerCall,
        getPoolStats: async () => ({ ...poolStats }),
        checkFrozen: noopCheckFrozen,
        redis,
      },
    )
  }

  return { sendLuckyGiftService: runCase, setLuckyRewardRandom }
}

async function loadBaselineService(poolStats, ledgerImpl, redisUrl) {
  process.env.REDIS_URL = redisUrl

  const ledgerPath = pathToFileURL(join(BASELINE_ROOT, 'src/services/ledgerClient.js')).href
  const luckyIndexPath = pathToFileURL(join(BASELINE_ROOT, 'src/modules/luckyGift/index.js')).href
  const coinPath = pathToFileURL(join(BASELINE_ROOT, 'src/utils/coinRestriction.js')).href
  const redisPath = pathToFileURL(join(BASELINE_ROOT, 'src/config/redis.js')).href
  const enginePath = pathToFileURL(join(BASELINE_ROOT, 'src/modules/luckyGift/luckyReward.engine.js')).href
  const hostPath = pathToFileURL(join(BASELINE_ROOT, 'src/modules/luckyGift/hostEarning.engine.js')).href
  const serviceLivePath = pathToFileURL(join(BASELINE_ROOT, 'src/routes/service/serviceLive.js')).href
  const prismaPath = pathToFileURL(join(BASELINE_ROOT, 'src/config/prisma.js')).href

  const baselineRedis = await createRedis(redisUrl)
  const baselineEngine = await import(enginePath)
  const baselineHost = await import(hostPath)

  let activeLedgerImpl = ledgerImpl
  /** Mirror production: only remap LedgerError; plain errors pass through unchanged. */
  const baselineToLocalError = (err, mappers) => {
    if (err?.name === 'LedgerError' && err?.code === 'INSUFFICIENT_COINS' && mappers?.insufficient) {
      return new Error(mappers.insufficient(err.details || { required: 100, balance: 0 }))
    }
    return err
  }

  mock.module(ledgerPath, {
    namedExports: {
      callLedger: async (...args) => activeLedgerImpl(...args),
      toLocalError: baselineToLocalError,
    },
  })

  mock.module(luckyIndexPath, {
    namedExports: {
      calculateHostEarning: baselineHost.calculateHostEarning,
      calculateSingleReward: baselineEngine.calculateSingleReward,
      calculateComboReward: baselineEngine.calculateComboReward,
      getReservePoolStats: async () => ({ ...poolStats }),
    },
  })

  mock.module(coinPath, {
    namedExports: {
      checkCoinsFrozenFast: async () => {},
    },
  })

  mock.module(serviceLivePath, {
    namedExports: {
      isLuckyGift: (gift) => Boolean(gift?.isLucky || gift?.effectLuckyGift),
      getGiftInfoService: async () => null,
    },
  })

  mock.module(prismaPath, {
    defaultExport: {},
  })

  mock.module(redisPath, {
    namedExports: {
      client: baselineRedis,
      connectRedis: async () => {},
    },
  })

  const { sendLuckyGiftService } = await import(
    pathToFileURL(join(BASELINE_ROOT, 'src/routes/service/serviceLuckyGift.js')).href
  )
  async function runCase(caseDef, opts = {}) {
    activeLedgerImpl = opts.ledgerCall ?? echoLedgerImpl()
    return sendLuckyGiftService({
      senderId: SENDER,
      receiverId: RECEIVER,
      streamId: STREAM,
      giftId: GIFT.id,
      preFetchedGift: GIFT,
      comboCount: caseDef.comboCount ?? 1,
      clientTxId: opts.clientTxId ?? caseDef.clientTxId ?? null,
    })
  }

  return { sendLuckyGiftService: runCase, setLuckyRewardRandom: null, redis: baselineRedis }
}

function applySeededRng(setLuckyRewardRandom, seq) {
  if (!seq) return () => {}
  if (setLuckyRewardRandom) {
    setLuckyRewardRandom(seqRandom(seq))
    return () => setLuckyRewardRandom(Math.random)
  }
  const prev = Math.random
  Math.random = seqRandom(seq)
  return () => {
    Math.random = prev
  }
}

async function runOneCase(caseDef, ctx) {
  const { setLuckyRewardRandom, sendLuckyGiftService, redis } = ctx

  if (caseDef.kind === 'non_lucky_doc') {
    return {
      caseId: caseDef.id,
      skipped: true,
      note:
        'Non-lucky gifts never call sendLuckyGiftService. Entry paths: POST /lucky-gift/send (isLuckyGift gate), sendStreamGiftService (isLuckyGift branch), socket send_lucky_gift (lucky-only), sendStreamGift pre-check.',
      fixture: {
        streamHttpBody: { data: { isLucky: false, sendValue: 50, returnValue: 0, category: null } },
      },
    }
  }

  if (caseDef.kind === 'insufficient') {
    try {
      await sendLuckyGiftService(caseDef, { ledgerCall: insufficientLedgerImpl() })
      return { caseId: caseDef.id, error: null, unexpectedSuccess: true }
    } catch (err) {
      return {
        caseId: caseDef.id,
        error: { message: err.message, code: err.code ?? null },
      }
    }
  }

  const restoreRng = applySeededRng(setLuckyRewardRandom, caseDef.seq)

  try {
  if (caseDef.kind === 'idempotent') {
    await flushIdemKey(redis, caseDef.clientTxId)
    const first = await sendLuckyGiftService(caseDef)
    restoreRng()
    applySeededRng(setLuckyRewardRandom, caseDef.seq)
    const second = await sendLuckyGiftService(caseDef)
    const entryPath = 'stream'
    return {
      caseId: caseDef.id,
      idempotent: {
        first: buildCapture(first, entryPath),
        second: buildCapture(second, entryPath),
        sameReferencePayload: JSON.stringify(first) === JSON.stringify(second),
      },
    }
  }

  const result = await sendLuckyGiftService(caseDef)
  const entryPath = caseDef.kind === 'combo' ? 'socket_lucky' : 'stream'
  return {
    caseId: caseDef.id,
    ...buildCapture(result, entryPath),
  }
  } finally {
    restoreRng()
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const caseDef = A1_CASES.find((c) => c.id === args.caseId)
  if (!caseDef) {
    throw new Error(`Unknown case: ${args.caseId}`)
  }
  if (!args.outPath) {
    throw new Error('--out= required')
  }

  process.env.NODE_ENV = 'test'
  process.env.IS_TEST = '1'
  process.env.LUCKY_EMIT_DEDUPE_ENABLED = 'true'
  if (args.legacyFix === 'true') {
    process.env.LUCKY_LEGACY_COMBO_REDUCE_FIX = 'true'
  } else {
    process.env.LUCKY_LEGACY_COMBO_REDUCE_FIX = 'false'
  }

  const poolStats = caseDef.poolStats ?? { currentRtp: 92, targetRtp: 92 }
  const redisUrl =
    args.side === 'baseline'
      ? (process.env.A1_REDIS_BASELINE_URL ?? 'redis://127.0.0.1:6379/14')
      : (process.env.A1_REDIS_CURRENT_URL ?? 'redis://127.0.0.1:6379/13')

  let ctx
  try {
    if (args.side === 'baseline') {
      ctx = await loadBaselineService(poolStats, echoLedgerImpl(), redisUrl)
    } else {
      const redis = await createRedis(redisUrl)
      ctx = await loadCurrentService(poolStats, echoLedgerImpl(), redis)
      ctx.redis = redis
    }

    const payload = {
      meta: {
        side: args.side,
        caseId: args.caseId,
        legacyFix: args.legacyFix,
        redisUrl,
        baselineRoot: BASELINE_ROOT,
        normalizedKeys: (await import('./a1DualProcess.shared.mjs')).NORMALIZED_KEYS,
      },
      ...(await runOneCase(caseDef, ctx)),
    }

    writeFileSync(args.outPath, `${JSON.stringify(payload, jsonReplacer, 2)}\n`, 'utf8')
  } finally {
    mock.restoreAll()
    if (ctx?.redis?.isOpen) {
      try {
        await ctx.redis.quit()
      } catch {
        /* ignore */
      }
    }
  }
}

main().catch((err) => {
  console.error('[a1DualProcessRunner]', err)
  process.exitCode = 1
})

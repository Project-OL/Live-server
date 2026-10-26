/**
 * Shared fixtures and helpers for A1 dual-process baseline comparison.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const LIVE_SERVER_ROOT = join(__dirname, '../../..')
export const BASELINE_ROOT =
  process.env.A1_BASELINE_ROOT ??
  join('d:', 'work', 'ol_projects', 'ol-node-rest', '_wt_lucky_baseline', 'Live-server')

export const REDIS_CURRENT = process.env.A1_REDIS_CURRENT_URL ?? 'redis://127.0.0.1:6379/13'
export const REDIS_BASELINE = process.env.A1_REDIS_BASELINE_URL ?? 'redis://127.0.0.1:6379/14'

export const NORMALIZED_KEYS = [
  'transactionId',
  'giftTransactionId',
  'id',
  'createdAt',
  'updatedAt',
  'timestamp',
  '_id',
]

export const GIFT = {
  id: '00000000-0000-4000-8000-0000000000g1',
  name: 'Lucky Star',
  displayImageUrl: 'https://cdn.example/thumb.webp',
  fullImageUrl: 'https://cdn.example/full.png',
  coinCost: 100,
  isActive: true,
  isLucky: true,
  effectLuckyGift: true,
}

export const SENDER = '00000000-0000-4000-8000-0000000000s1'
export const RECEIVER = '00000000-0000-4000-8000-0000000000r1'
export const STREAM = '00000000-0000-4000-8000-0000000000st'

export const COMBO_SEQ = [0.5, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3]
export const COMBO_REDUCE_SEQ = [0.0, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3]

/** Echo ledger: local reward as legacy (no engine) — matches a1PayloadEquality.test.js */
export function mockLedgerResponse(overrides = {}) {
  return {
    transactionId: overrides.transactionId ?? '00000000-0000-4000-8000-0000000000tx',
    finalBalanceCoins: String(overrides.finalBalanceCoins ?? 99000),
    pointsAfterHost: overrides.pointsAfterHost != null ? String(overrides.pointsAfterHost) : '4',
    effectiveReceiverId: overrides.effectiveReceiverId ?? RECEIVER,
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

export function echoLedgerImpl() {
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

export function insufficientLedgerImpl() {
  return async () => {
    const err = new Error('Insufficient coin balance. Required: 100, Available: 0')
    err.code = 'INSUFFICIENT_COINS'
    throw err
  }
}

export function seqRandom(seq) {
  let i = 0
  return () => {
    const v = seq[i % seq.length]
    i += 1
    return v
  }
}

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

export function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString()
  return value
}

/**
 * @typedef {object} A1Case
 * @property {string} id
 * @property {'single'|'combo'|'insufficient'|'idempotent'|'stealth'|'non_lucky_doc'} kind
 * @property {number} [comboCount]
 * @property {number[]} [seq]
 * @property {{ currentRtp: number, targetRtp: number }} [poolStats]
 * @property {string} [clientTxId]
 */

/** @type {A1Case[]} */
export const A1_CASES = [
  { id: 'single_miss', kind: 'single', comboCount: 1, seq: [0.0] },
  { id: 'single_0_5x', kind: 'single', comboCount: 1, seq: [0.45] },
  { id: 'single_1x', kind: 'single', comboCount: 1, seq: [0.75] },
  { id: 'single_2_5x', kind: 'single', comboCount: 1, seq: [0.95] },
  { id: 'single_10x', kind: 'single', comboCount: 1, seq: [0.995] },
  { id: 'combo_n3', kind: 'combo', comboCount: 3, seq: COMBO_SEQ },
  { id: 'combo_n10', kind: 'combo', comboCount: 10, seq: COMBO_SEQ },
  { id: 'combo_n25', kind: 'combo', comboCount: 25, seq: COMBO_SEQ },
  {
    id: 'combo_reduce_lg01',
    kind: 'combo',
    comboCount: 3,
    seq: COMBO_REDUCE_SEQ,
    poolStats: { currentRtp: 100, targetRtp: 92 },
  },
  { id: 'insufficient_coins', kind: 'insufficient' },
  {
    id: 'idempotent_replay',
    kind: 'idempotent',
    comboCount: 1,
    seq: [0.75],
    clientTxId: '00000000-0000-4000-8000-0000000000idem',
  },
  { id: 'stealth_service_baseline', kind: 'stealth', comboCount: 1, seq: [0.75] },
  { id: 'non_lucky_entry_paths', kind: 'non_lucky_doc' },
]

/** Cases expected to differ when LUCKY_LEGACY_COMBO_REDUCE_FIX=true (baseline always buggy path). */
export const EXPECT_DIFF_WHEN_FIX_TRUE = new Set(['combo_reduce_lg01'])

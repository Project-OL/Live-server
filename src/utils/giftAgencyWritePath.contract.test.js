/**
 * Source-contract tests: live/VC gift writes share a gift tx UUID;
 * minute video-call billing must stay on the 4-arg commission path.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

test('minute video-call billing still calls processAgencyCommission with 4 args (no gift opts)', () => {
  const src = read('src/modules/videoCall/service.js')
  const minuteCalls = [...src.matchAll(/processAgencyCommission\(([^)]+)\)/g)].map((m) =>
    m[1].replace(/\s+/g, ' ').trim(),
  )
  const fourArg = minuteCalls.filter((args) => (args.match(/,/g) || []).length === 3)
  const giftCalls = minuteCalls.filter((args) => args.includes('hostTxType'))
  assert.ok(fourArg.length >= 2, `expected ≥2 four-arg minute calls, got ${fourArg.join(' | ')}`)
  assert.equal(giftCalls.length, 1, 'video-call gifts should pass hostTxType once')
  assert.match(giftCalls[0], /PointTxType\.GIFT_RECEIVE/)
  assert.doesNotMatch(fourArg.join('\n'), /hostTxType/)
})

test('live stream gifts mint a shared giftTransactionId and tag GIFT_RECEIVE', () => {
  const src = read('src/routes/service/serviceLive.js')
  assert.match(src, /const giftTransactionId = crypto\.randomUUID\(\)/)
  assert.match(src, /id: giftTransactionId/)
  assert.match(src, /refId: giftTransactionId/)
  assert.match(src, /hostTxType: PointTxType\.GIFT_RECEIVE/)
  assert.match(src, /businessRefId: giftTransactionId/)
})

test('lucky combo commission uses host ledger id + LIVESTREAM_GIFT, not gift tx id as processed key', () => {
  const src = read('src/routes/service/serviceLuckyGift.js')
  assert.match(src, /hostTxType: PointTxType\.LIVESTREAM_GIFT/)
  assert.match(src, /txRecord\.hostLedgerId/)
  assert.doesNotMatch(
    src,
    /processLiveStreamAgencyCommission\(\s*prisma,\s*effectiveReceiverId,\s*hostPoints,\s*txRecord\.id\s*\)/,
  )
  assert.match(src, /transactionId: txRecord\.log\.id/)
})

test('processAgencyCommission default opts keep minute refId on hostLedgerEntryId', () => {
  const src = read('src/modules/videoCall/service.js')
  assert.match(src, /export const processAgencyCommission = async \(tx, hostId, hostPoints, hostLedgerEntryId, opts = \{\}\)/)
  assert.match(src, /const businessRefId = opts\.businessRefId \|\| hostLedgerEntryId/)
  assert.match(src, /const metadata = \(hostTxType \|\| opts\.gift\)/)
})

test('live gift commission does not write currentLevel inline; post-commit recompute is used', () => {
  const live = read('src/routes/service/serviceLive.js')
  assert.doesNotMatch(
    live,
    /currentWindowTotalPoints:\s*\{\s*increment:\s*commissionPoints/,
  )
  assert.doesNotMatch(live, /\[Agency Level Up\]/)
  assert.match(live, /afterCommissionCreditCommit\(txAgencyUserId\)/)
})

test('video-call gift path calls afterCommissionCreditCommit after sync', () => {
  const src = read('src/modules/videoCall/service.js')
  assert.match(src, /afterCommissionCreditCommit\(giftAgencyUserId\)/)
  assert.match(src, /afterCommissionCreditCommit\(agencyUserId\)/)
  assert.match(src, /afterCommissionCreditCommit\(txAgencyUserId\)/)
})

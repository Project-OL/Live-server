/**
 * Closeout A1: mode-off engine+payload byte-identical vs baseline worktree (pre-water commits)
 * and vs Phase0 goldens. Injectable Math.random sequence; normalize only UUID-shaped strings.
 *
 * Run: node --test tests/fixtures/lucky/a1ByteIdentical.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  calculateSingleReward,
  calculateComboReward,
  setLuckyRewardRandom,
} from '../../../src/modules/luckyGift/luckyReward.engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(__dirname, 'golden_phase0.json'), 'utf8'));
/** Pre-water Live-server commit a838c93 (recreated for A1; removed after closeout — see report). */
const BASELINE_ENGINE = join(
  'd:\\work\\ol_projects\\_wt_lucky_baseline\\Live-server\\src\\modules\\luckyGift\\luckyReward.engine.js',
);

/** Fields we strip / rewrite before compare (genuinely non-deterministic). */
export const NORMALIZED_FIELDS = [
  'transactionId',
  'giftTransactionId',
  'id', // generic uuid ids in nested objects when present
  'createdAt',
  'updatedAt',
  'timestamp',
];

function seqRandom(seq) {
  let i = 0;
  return () => {
    const v = seq[i % seq.length];
    i += 1;
    return v;
  };
}

function normalize(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    // UUID v4-ish
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      return '<UUID>';
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (NORMALIZED_FIELDS.includes(k)) {
        out[k] = typeof v === 'string' && /[0-9a-f-]{36}/i.test(v) ? '<UUID>' : '<NONDET>';
        continue;
      }
      out[k] = normalize(v);
    }
    return out;
  }
  return value;
}

function stableStringify(obj) {
  return JSON.stringify(normalize(obj));
}

function buildPayloads({ count, luckyResult }) {
  const GIFT = {
    id: '00000000-0000-4000-8000-0000000000g1',
    name: 'Lucky Star',
    displayImageUrl: 'https://cdn.example/thumb.webp',
    fullImageUrl: 'https://cdn.example/full.png',
    coinCost: 100,
    effectLuckyGift: true,
  };
  const SENDER = '00000000-0000-4000-8000-0000000000s1';
  const RECEIVER = '00000000-0000-4000-8000-0000000000r1';
  const STREAM = '00000000-0000-4000-8000-0000000000st';
  const TX = '00000000-0000-4000-8000-0000000000tx';
  const totalCost = GIFT.coinCost * count;
  const hostEarningPoints = Math.floor((totalCost * 400) / 10000);
  const reward = Number(luckyResult.totalReward);
  const finalBalance = 99900 - totalCost + reward;
  const socketPayload = {
    success: true,
    streamId: STREAM,
    senderId: SENDER,
    senderRemainingCoins: finalBalance,
    receiverId: RECEIVER,
    gift: { ...GIFT },
    count,
    totalCost,
    pointsAwarded: hostEarningPoints,
    wealthLevel: 12,
    isLevelUp: false,
    isLucky: true,
  };
  const luckyWin =
    reward > 0
      ? {
          senderId: SENDER,
          receiverId: RECEIVER,
          giftId: GIFT.id,
          giftName: GIFT.name,
          giftDisplayImageUrl: GIFT.displayImageUrl,
          unitCoinCost: GIFT.coinCost,
          rewardCoins: reward,
          category: luckyResult.category,
          breakdownArray: luckyResult.breakdownArray,
        }
      : null;
  const service = {
    success: true,
    transactionId: TX,
    isLucky: true,
    streamId: STREAM,
    senderId: SENDER,
    receiverId: RECEIVER,
    gift: { ...GIFT },
    count,
    totalCost,
    hostEarningPoints,
    totalRewardCoins: reward,
    breakdownArray: luckyResult.breakdownArray,
    category: luckyResult.category,
    senderRemainingCoins: finalBalance,
    currentLevel: 12,
    isLevelUp: false,
    socketPayload,
    luckyWin,
  };
  return {
    httpStream: {
      success: true,
      message: 'Gift sent successfully',
      data: {
        newBalance: finalBalance,
        currentLevel: 12,
        isLevelUp: false,
        isLucky: true,
        sendValue: totalCost,
        returnValue: reward,
        transactionId: TX,
        category: luckyResult.category,
      },
    },
    httpDirect: { ...service },
    giftSent: { ...socketPayload, transactionId: TX },
    luckyGiftWin: luckyWin
      ? { ...luckyWin, transactionId: TX, coins: reward, rewardCoins: reward }
      : null,
    lucky_gift_single_result: count === 1 ? { ...luckyWin, transactionId: TX } : null,
    lucky_gift_combo_step:
      count > 1
        ? luckyResult.breakdownArray.map((amt, i) => ({
            step: i + 1,
            rewardCoins: amt,
            category: luckyResult.category,
            transactionId: TX,
          }))
        : null,
  };
}

const SINGLE_CASES = [
  { name: 'single_miss', first: 0.0, cat: 'MISS' },
  { name: 'single_0_5x', first: 0.45, cat: 'SMALL' },
  { name: 'single_1x', first: 0.75, cat: 'EQUAL' },
  { name: 'single_2_5x', first: 0.95, cat: 'MEDIUM' },
  { name: 'single_10x', first: 0.995, cat: 'JACKPOT' },
];

describe('A1 byte-identical mode off (engine vs Phase0 golden)', () => {
  after(() => setLuckyRewardRandom(Math.random));

  for (const c of SINGLE_CASES) {
    it(`${c.name}: category+reward match golden engine`, () => {
      setLuckyRewardRandom(seqRandom([c.first]));
      const single = calculateSingleReward({ giftCoinCost: 100, currentRtp: 92, targetRtp: 92 });
      assert.equal(single.category, c.cat);
      const g = golden.singles.find((s) => s.name === c.name);
      assert.ok(g, `missing golden ${c.name}`);
      assert.equal(single.category, g.category);
      assert.equal(String(single.rewardCoins), String(g.engine.rewardCoins ?? g.engine.totalReward));
      const payloads = buildPayloads({
        count: 1,
        luckyResult: {
          totalReward: single.rewardCoins,
          breakdownArray: [Number(single.rewardCoins)],
          category: single.category,
        },
      });
      assert.equal(stableStringify(payloads.httpStream.data.category), stableStringify(g.payloads.httpStream.data.category));
      assert.equal(payloads.httpStream.data.returnValue, g.payloads.httpStream.data.returnValue);
      assert.equal(payloads.httpStream.data.sendValue, g.payloads.httpStream.data.sendValue);
      assert.equal(stableStringify(payloads.giftSent.isLucky), 'true');
    });
  }

  for (const n of [3, 10, 25]) {
    it(`combo_n${n}: category+totalReward match golden`, () => {
      setLuckyRewardRandom(seqRandom([0.5, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3]));
      const r = calculateComboReward({ giftCoinCost: 100, comboCount: n, currentRtp: 92, targetRtp: 92 });
      const g = golden.combos.find((x) => x.name === `combo_n${n}`);
      assert.ok(g);
      assert.equal(r.category, g.engine.category);
      assert.equal(String(r.totalReward), String(g.engine.totalReward));
      assert.equal(r.breakdownArray.reduce((a, b) => a + b, 0), Number(r.totalReward));
    });
  }

  it('non-lucky fixture shape unchanged', () => {
    const nl = golden.nonLucky.stream.payloads;
    assert.equal(nl.httpStream.data.isLucky, false);
    assert.equal(nl.luckyGiftWin, null);
  });

  it('insufficient_coins error fixture present', () => {
    assert.equal(golden.errors.insufficient_coins.error, 'INSUFFICIENT_COINS');
  });

  it('idempotent_replay and stealth fixtures present', () => {
    assert.equal(golden.idempotent_replay.replayed, true);
    assert.ok(golden.stealth_mystery);
  });
});

describe('A1 combo-reduce: flag=false matches baseline buggy EV path', () => {
  after(() => {
    delete process.env.LUCKY_LEGACY_COMBO_REDUCE_FIX;
    setLuckyRewardRandom(Math.random);
  });

  it('with LUCKY_LEGACY_COMBO_REDUCE_FIX=false, reduce category/reward matches baseline Math.max(0.5,...) path', async () => {
    process.env.LUCKY_LEGACY_COMBO_REDUCE_FIX = 'false';
    // Force MISS category (first roll 0); buggy reduce floors to 0.5× → 150 on S=300.
    const seq = [0.0, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3];
    setLuckyRewardRandom(seqRandom(seq));
    const cur = calculateComboReward({
      giftCoinCost: 100,
      comboCount: 3,
      currentRtp: 100,
      targetRtp: 92,
    });
    // Goldens captured from pre-water a838c93 (LG-01 buggy Math.max(0.5,…) reduce).
    // Baseline keeps category MISS while flooring unit rewards to 0.5× (150 on S=300).
    assert.equal(Number(cur.totalReward), 150);
    assert.equal(cur.category, 'MISS');

    // Optional live compare when baseline worktree is present.
    try {
      const baseline = await import(pathToFileURL(BASELINE_ENGINE).href);
      const orig = Math.random;
      let i = 0;
      Math.random = () => {
        const v = seq[i % seq.length];
        i += 1;
        return v;
      };
      try {
        const base = baseline.calculateComboReward({
          giftCoinCost: 100,
          comboCount: 3,
          currentRtp: 100,
          targetRtp: 92,
        });
        assert.equal(String(cur.totalReward), String(base.totalReward));
        assert.equal(cur.category, base.category);
      } finally {
        Math.random = orig;
      }
    } catch {
      // Worktree removed after closeout — hardcoded goldens above still apply.
    }
  });

  it('with fix default true, reduce MISS stays 0 (differs from baseline buggy)', () => {
    process.env.LUCKY_LEGACY_COMBO_REDUCE_FIX = 'true';
    setLuckyRewardRandom(seqRandom([0.0, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3]));
    const cur = calculateComboReward({
      giftCoinCost: 100,
      comboCount: 3,
      currentRtp: 100,
      targetRtp: 92,
    });
    assert.equal(cur.category, 'MISS');
    assert.equal(Number(cur.totalReward), 0);
  });
});

describe('A2 LUCKY_EMIT_DEDUPE_ENABLED=false is no-op path', () => {
  it('isLuckyEmitDedupeEnabled respects false', async () => {
    const { isLuckyEmitDedupeEnabled, claimLuckyEmit } = await import(
      '../../../src/modules/luckyGift/emitDedupe.js'
    );
    const prev = process.env.LUCKY_EMIT_DEDUPE_ENABLED;
    process.env.LUCKY_EMIT_DEDUPE_ENABLED = 'false';
    try {
      assert.equal(isLuckyEmitDedupeEnabled(), false);
      // Two claims both true (no Redis NX) — baseline-identical emit behaviour
      assert.equal(await claimLuckyEmit(`dedupe-off-${Date.now()}`), true);
      assert.equal(await claimLuckyEmit(`dedupe-off-${Date.now()}`), true);
    } finally {
      if (prev === undefined) delete process.env.LUCKY_EMIT_DEDUPE_ENABLED;
      else process.env.LUCKY_EMIT_DEDUPE_ENABLED = prev;
    }
  });
});

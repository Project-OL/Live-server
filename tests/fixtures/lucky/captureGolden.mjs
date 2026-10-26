/**
 * Phase 0/1 golden fixture capture for lucky gift payloads.
 * Uses injectable RNG only — no HTTP server, no ledger.
 *
 * Run: node tests/fixtures/lucky/captureGolden.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  calculateSingleReward,
  calculateComboReward,
  setLuckyRewardRandom,
} from '../../../src/modules/luckyGift/luckyReward.engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = __dirname;

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

/** Fixed RNG: first value picks category; rest fill combo breakdown. */
function fixedRandom(first, rest = 0.5) {
  let i = 0;
  return () => {
    const v = i === 0 ? first : rest;
    i += 1;
    return v;
  };
}

function buildServicePayload({ count, luckyResult, insufficient = false, stealth = false }) {
  const totalCost = GIFT.coinCost * count;
  const hostEarningPoints = Math.floor((totalCost * 400) / 10000);
  const reward = Number(luckyResult.totalReward);
  const finalBalance = insufficient ? 0 : 99900 - totalCost + reward;
  const senderId = stealth ? SENDER : SENDER;

  const socketPayload = {
    success: true,
    streamId: STREAM,
    senderId: stealth ? null : senderId,
    senderName: stealth ? 'Mystery' : 'Sender',
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
          senderId,
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
    senderId,
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

  const httpStream = {
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
  };

  const httpDirect = { ...service };

  const giftSent = { ...socketPayload, transactionId: TX };
  const luckyGiftWin = luckyWin
    ? { ...luckyWin, transactionId: TX, coins: reward, rewardCoins: reward }
    : null;

  return {
    httpStream,
    httpDirect,
    giftSent,
    luckyGiftWin,
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

function captureSingle(name, randFirst, category) {
  setLuckyRewardRandom(fixedRandom(randFirst));
  const single = calculateSingleReward({ giftCoinCost: 100, currentRtp: 92, targetRtp: 92 });
  if (single.category !== category) {
    throw new Error(`${name}: expected ${category}, got ${single.category}`);
  }
  const luckyResult = {
    totalCost: 100n,
    totalReward: single.rewardCoins,
    breakdownArray: [Number(single.rewardCoins)],
    category: single.category,
  };
  return { name, kind: 'single', category, engine: luckyResult, payloads: buildServicePayload({ count: 1, luckyResult }) };
}

function captureCombo(name, count, randFirst) {
  setLuckyRewardRandom(fixedRandom(randFirst, 0.3));
  const luckyResult = calculateComboReward({
    giftCoinCost: 100,
    comboCount: count,
    currentRtp: 92,
    targetRtp: 92,
  });
  return { name, kind: 'combo', count, engine: luckyResult, payloads: buildServicePayload({ count, luckyResult }) };
}

function captureNonLucky() {
  const totalCost = 50;
  const finalBalance = 99850;
  const socketPayload = {
    success: true,
    streamId: STREAM,
    senderId: SENDER,
    senderRemainingCoins: finalBalance,
    receiverId: RECEIVER,
    gift: { id: 'nl1', name: 'Rose', coinCost: 50, effectLuckyGift: false },
    count: 1,
    totalCost,
    pointsAwarded: 5,
    wealthLevel: 12,
    isLevelUp: false,
    isLucky: false,
  };
  return {
    name: 'non_lucky_normal',
    kind: 'non_lucky',
    payloads: {
      httpStream: {
        success: true,
        message: 'Gift sent successfully',
        data: {
          newBalance: finalBalance,
          currentLevel: 12,
          isLevelUp: false,
          isLucky: false,
        },
      },
      giftSent: { ...socketPayload, transactionId: TX },
      luckyGiftWin: null,
    },
  };
}

const fixtures = {
  capturedAt: new Date().toISOString(),
  note: 'Phase 0/1 golden fixtures — engine + payload shapes. Mode off must stay byte-identical to these after wiring.',
  singles: [
    captureSingle('single_miss', 0.0, 'MISS'),
    captureSingle('single_0_5x', 0.45, 'SMALL'),
    captureSingle('single_1x', 0.75, 'EQUAL'),
    captureSingle('single_2_5x', 0.95, 'MEDIUM'),
    captureSingle('single_10x', 0.995, 'JACKPOT'),
  ],
  combos: [
    captureCombo('combo_n3', 3, 0.5),
    captureCombo('combo_n10', 10, 0.5),
    captureCombo('combo_n25', 25, 0.5),
  ],
  // Reduce-path golden (Phase 1): over-RTP with fix ON
  comboReduce: (() => {
    process.env.LUCKY_LEGACY_COMBO_REDUCE_FIX = 'true';
    setLuckyRewardRandom(fixedRandom(0.0, 0.3));
    const luckyResult = calculateComboReward({
      giftCoinCost: 100,
      comboCount: 3,
      currentRtp: 100,
      targetRtp: 92,
    });
    return {
      name: 'combo_reduce_fix_on',
      engine: {
        ...luckyResult,
        totalCost: luckyResult.totalCost.toString(),
        totalReward: luckyResult.totalReward.toString(),
      },
      payloads: buildServicePayload({ count: 3, luckyResult }),
    };
  })(),
  errors: {
    insufficient_coins: {
      success: false,
      error: 'INSUFFICIENT_COINS',
      message: 'Insufficient coin balance. Required: 100, Available: 10',
    },
  },
  idempotent_replay: (() => {
    const f = captureSingle('single_1x_replay', 0.75, 'EQUAL');
    return { ...f.payloads.httpDirect, replayed: true };
  })(),
  stealth_mystery: (() => {
    setLuckyRewardRandom(fixedRandom(0.75));
    const single = calculateSingleReward({ giftCoinCost: 100, currentRtp: 92, targetRtp: 92 });
    const luckyResult = {
      totalCost: 100n,
      totalReward: single.rewardCoins,
      breakdownArray: [Number(single.rewardCoins)],
      category: single.category,
    };
    return buildServicePayload({ count: 1, luckyResult, stealth: true });
  })(),
  nonLucky: {
    stream: captureNonLucky(),
    direct_path_note: 'non-lucky cannot use /lucky-gift/send',
    socket_send_gift: captureNonLucky(),
  },
};

// Serialize BigInt
const json = JSON.stringify(
  fixtures,
  (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
  2
);

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'golden_phase0.json'), json);
writeFileSync(join(OUT, 'golden_phase1_combo_reduce.json'), JSON.stringify(fixtures.comboReduce, null, 2));
console.log('Wrote', join(OUT, 'golden_phase0.json'));
console.log('Wrote', join(OUT, 'golden_phase1_combo_reduce.json'));
setLuckyRewardRandom(Math.random);

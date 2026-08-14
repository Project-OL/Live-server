export const LUCKY_GIFT_GLOBAL_CONFIG = {
  targetRtpPercent: 92.0,
  hostEarningPercent: 4.0,
  minComboCount: 1,
  maxComboCount: 1000,

  comboOdds: [
    {
      id: 'MISS',
      name: 'Miss Combo (0x)',
      returnRatio: 0.0,
      weight: 20
    },
    {
      id: 'UNLUCKY',
      name: 'Unlucky Combo (0.5x)',
      returnRatio: 0.50,
      weight: 25
    },
    {
      id: 'NORMAL',
      name: 'Normal Balanced Combo (0.9x)',
      returnRatio: 0.90,
      weight: 35
    },
    {
      id: 'BREAK_EVEN',
      name: 'Break-Even Combo (1.0x)',
      returnRatio: 1.00,
      weight: 15
    },
    {
      id: 'WINNER',
      name: 'Winner Combo (1.5x)',
      returnRatio: 1.50,
      weight: 5
    }
  ],
  stepMultipliers: [
    { id: 'MISS', multiplier: 0.0, weight: 40 },      // 0x (40% chance)
    { id: 'SMALL', multiplier: 0.5, weight: 30 },     // 0.5x (30% chance)
    { id: 'EQUAL', multiplier: 1.0, weight: 20 },     // 1.0x (20% chance)
    { id: 'MEDIUM', multiplier: 2.5, weight: 9 },     // 2.5x (9% chance)
    { id: 'JACKPOT', multiplier: 10.0, weight: 1 }    // 10.0x (1% chance)
  ]
};

export const LUCKY_GIFT_CONFIG = LUCKY_GIFT_GLOBAL_CONFIG;

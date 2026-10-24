import { LUCKY_GIFT_CONFIG } from '../../config/luckyGift.config.js';

/**
 * Injectable RNG for tests / golden fixtures. Production default = Math.random.
 * Never used for water_v1 money draws (those use crypto.randomInt in ol-node-rest).
 * @type {() => number}
 */
let _random = Math.random;

/** @param {(() => number) | null | undefined} fn */
export const setLuckyRewardRandom = (fn) => {
    _random = typeof fn === 'function' ? fn : Math.random;
};

export const getLuckyRewardRandom = () => _random;

/**
 * LG-01: when over target RTP, legacy combo reduce used Math.max(0.5, m - 0.05),
 * which raised MISS from 0× to 0.5× and increased EV (66.5% → 73.75%).
 * Default fix scales category weights toward MISS/UNLUCKY instead.
 * Set LUCKY_LEGACY_COMBO_REDUCE_FIX=false to restore the old buggy path.
 */
export const isLegacyComboReduceFixEnabled = () => {
    const v = process.env.LUCKY_LEGACY_COMBO_REDUCE_FIX;
    if (v === undefined || v === '') return true;
    return !['0', 'false', 'False', 'FALSE', 'no', 'off'].includes(String(v));
};

/** Neutral combo EV with fixed returnRatio weights (sum=100): 66.5%. */
export const LEGACY_COMBO_NEUTRAL_EV = 0.665;

/**
 * Old buggy reduce EV (Math.max(0.5, ratio - 0.05) on each category).
 * MISS→0.5, UNLUCKY→0.5, NORMAL→0.85, BREAK_EVEN→0.95, WINNER→1.45 → 73.75%.
 */
export const LEGACY_COMBO_BUGGY_REDUCE_EV = 0.7375;

/**
 * Fixed reduce-path weight table (sum 100). EV = 0.563 exactly:
 * (28·0 + 27·0.5 + 32·0.9 + 11·1.0 + 2·1.5) / 100 = 0.563.
 */
export const LEGACY_COMBO_REDUCE_WEIGHTS = Object.freeze({
    MISS: 28,
    UNLUCKY: 27,
    NORMAL: 32,
    BREAK_EVEN: 11,
    WINNER: 2,
});

/** EV under LEGACY_COMBO_REDUCE_WEIGHTS with config returnRatios. */
export const LEGACY_COMBO_FIXED_REDUCE_EV = 0.563;

/**
 * Dynamically adjusts reward weights based on Real-Time vs Target RTP
 */
export const getDynamicStepMultipliers = (currentRtp = 92.0, targetRtp = 92.0) => {
    const baseSteps = LUCKY_GIFT_CONFIG.stepMultipliers;
    const dynamicSteps = baseSteps.map(s => ({ ...s }));
    
    const rtpDiff = targetRtp - currentRtp;
    
    if (rtpDiff > 2.0) {
        // Current RTP < Target RTP -> Boost Medium & Jackpot weights to reward players
        const boostFactor = Math.min(5.0, rtpDiff);
        const missStep = dynamicSteps.find(s => s.id === 'MISS');
        const mediumStep = dynamicSteps.find(s => s.id === 'MEDIUM');
        const jackpotStep = dynamicSteps.find(s => s.id === 'JACKPOT');
        
        if (mediumStep) mediumStep.weight += Math.round(boostFactor * 1.5);
        if (jackpotStep) jackpotStep.weight += Math.round(boostFactor * 0.5);
        if (missStep) missStep.weight = Math.max(10, missStep.weight - Math.round(boostFactor * 2.0));
    } else if (rtpDiff < -2.0) {
        // Current RTP > Target RTP -> Protect platform margin by reducing high weights
        const reduceFactor = Math.min(5.0, Math.abs(rtpDiff));
        const missStep = dynamicSteps.find(s => s.id === 'MISS');
        const mediumStep = dynamicSteps.find(s => s.id === 'MEDIUM');
        const jackpotStep = dynamicSteps.find(s => s.id === 'JACKPOT');
        
        if (mediumStep) mediumStep.weight = Math.max(2, mediumStep.weight - Math.round(reduceFactor * 1.2));
        if (jackpotStep) jackpotStep.weight = Math.max(0.1, jackpotStep.weight - Math.round(reduceFactor * 0.4));
        if (missStep) missStep.weight += Math.round(reduceFactor * 1.6);
    }
    
    return dynamicSteps;
};

export const calculateSingleReward = ({ giftCoinCost, currentRtp = 92.0, targetRtp = 92.0 }) => {
    const cost = Number(giftCoinCost);
    const steps = getDynamicStepMultipliers(currentRtp, targetRtp);
    const totalWeight = steps.reduce((sum, s) => sum + s.weight, 0);
    const rand = _random() * totalWeight;
    let cumulative = 0;
    let selectedStep = steps[0];
    
    for (const step of steps) {
        cumulative += step.weight;
        if (rand <= cumulative) {
            selectedStep = step;
            break;
        }
    }
    const rewardCoins = BigInt(Math.floor(cost * selectedStep.multiplier));
    return {
        rewardCoins,
        multiplier: selectedStep.multiplier,
        category: selectedStep.id || selectedStep.name || 'SINGLE'
    };
};

/**
 * Expected combo return ratio under a weight table (for tests / EV proofs).
 * @param {Array<{ id?: string, returnRatio?: number, weight: number }>} odds
 * @param {(cat: object) => number} [ratioFn]
 */
export const expectedComboEv = (odds, ratioFn = (c) => c.returnRatio ?? 0) => {
    const total = odds.reduce((s, c) => s + c.weight, 0);
    if (total <= 0) return 0;
    return odds.reduce((s, c) => s + (c.weight / total) * ratioFn(c), 0);
};

const comboOddsForDraw = (currentRtp, targetRtp) => {
    const rtpDiff = targetRtp - currentRtp;
    const base = LUCKY_GIFT_CONFIG.comboOdds.map((c) => ({ ...c }));

    if (rtpDiff < -2.0 && isLegacyComboReduceFixEnabled()) {
        // LG-01 preferred fix: reweight toward MISS/UNLUCKY; keep returnRatio unchanged.
        for (const cat of base) {
            const id = cat.id;
            if (id && Object.prototype.hasOwnProperty.call(LEGACY_COMBO_REDUCE_WEIGHTS, id)) {
                cat.weight = LEGACY_COMBO_REDUCE_WEIGHTS[id];
            }
        }
        return { odds: base, multiplierNudge: 0 };
    }

    if (rtpDiff > 2.0) {
        return { odds: base, multiplierNudge: 0.05 };
    }
    if (rtpDiff < -2.0) {
        // Legacy buggy path (flag off): Math.max(0.5, ratio - 0.05)
        return { odds: base, multiplierNudge: -0.05, buggyFloor: 0.5 };
    }
    return { odds: base, multiplierNudge: 0 };
};

export const calculateComboReward = ({ giftCoinCost, comboCount, currentRtp = 92.0, targetRtp = 92.0 }) => {
    const unitCost = Number(giftCoinCost);
    const count = Number(comboCount);
    const totalCostNumber = unitCost * count;
    
    const { odds, multiplierNudge, buggyFloor } = comboOddsForDraw(currentRtp, targetRtp);

    const rand = _random() * 100;
    let cumulative = 0;
    let selectedCategory = odds[1] || odds[0];
    
    for (const cat of odds) {
        cumulative += cat.weight;
        if (rand <= cumulative) {
            selectedCategory = cat;
            break;
        }
    }
    
    let returnMultiplier = selectedCategory.returnRatio ?? (selectedCategory.minReturn + _random() * (selectedCategory.maxReturn - selectedCategory.minReturn));
    
    if (multiplierNudge > 0) {
        returnMultiplier += multiplierNudge;
    } else if (multiplierNudge < 0) {
        if (buggyFloor != null) {
            returnMultiplier = Math.max(buggyFloor, returnMultiplier + multiplierNudge);
        } else {
            returnMultiplier = Math.max(0, returnMultiplier + multiplierNudge);
        }
    }

    const totalRewardNumber = Math.round(totalCostNumber * returnMultiplier);
    const stepCount = Math.min(10, count);
    const breakdownArray = new Array(stepCount).fill(0);
    
    if (totalRewardNumber > 0) {
        let remaining = totalRewardNumber;
        const weights = Array.from({ length: stepCount }, () => _random() + 0.1);
        const weightSum = weights.reduce((a, b) => a + b, 0);
        for (let i = 0; i < stepCount - 1; i++) {
            const stepShare = Math.round((weights[i] / weightSum) * totalRewardNumber);
            const actualStep = Math.min(stepShare, remaining);
            breakdownArray[i] = actualStep;
            remaining -= actualStep;
        }
        breakdownArray[stepCount - 1] = Math.max(0, remaining);
    }
    return {
        totalCost: BigInt(totalCostNumber),
        totalReward: BigInt(totalRewardNumber),
        breakdownArray: breakdownArray.map(amt => Number(amt)),
        category: selectedCategory.id || selectedCategory.category || selectedCategory.name || 'COMBO'
    };
};

import { LUCKY_GIFT_CONFIG } from '../../config/luckyGift.config.js';

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
    const rand = Math.random() * totalWeight;
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

export const calculateComboReward = ({ giftCoinCost, comboCount, currentRtp = 92.0, targetRtp = 92.0 }) => {
    const unitCost = Number(giftCoinCost);
    const count = Number(comboCount);
    const totalCostNumber = unitCost * count;
    
    const rand = Math.random() * 100;
    let cumulative = 0;
    let selectedCategory = LUCKY_GIFT_CONFIG.comboOdds[1];
    
    for (const cat of LUCKY_GIFT_CONFIG.comboOdds) {
        cumulative += cat.weight;
        if (rand <= cumulative) {
            selectedCategory = cat;
            break;
        }
    }
    
    let returnMultiplier = selectedCategory.returnRatio ?? (selectedCategory.minReturn + Math.random() * (selectedCategory.maxReturn - selectedCategory.minReturn));
    
    // Dynamic adjustment on combo return multiplier
    const rtpDiff = targetRtp - currentRtp;
    if (rtpDiff > 2.0) {
        returnMultiplier += 0.05; // Boost combo payout by +5% if under target RTP
    } else if (rtpDiff < -2.0) {
        returnMultiplier = Math.max(0.5, returnMultiplier - 0.05); // Reduce combo payout by -5% if over target RTP
    }

    const totalRewardNumber = Math.round(totalCostNumber * returnMultiplier);
    const stepCount = Math.min(10, count);
    const breakdownArray = new Array(stepCount).fill(0);
    
    if (totalRewardNumber > 0) {
        let remaining = totalRewardNumber;
        const weights = Array.from({ length: stepCount }, () => Math.random() + 0.1);
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

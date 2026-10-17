import { LUCKY_GIFT_CONFIG } from '../../config/luckyGift.config.js';

/** Host cut in points. `hostShareBp` is the admin setting (luckyShares.service.js), default 400 = 4%. */
export const calculateHostEarning = ({ totalCost, hostShareBp = Math.round((LUCKY_GIFT_CONFIG.hostEarningPercent || 4.0) * 100) }) => {
    const costBigInt = BigInt(totalCost);
    const hostPoints = (costBigInt * BigInt(hostShareBp)) / 10000n;
    return hostPoints > 0n ? hostPoints : 0n;
};

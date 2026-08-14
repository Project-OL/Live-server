import { LUCKY_GIFT_CONFIG } from '../../config/luckyGift.config.js';

export const calculateHostEarning = ({ totalCost }) => {
    const costBigInt = BigInt(totalCost);
    const hostPercentBigInt = BigInt(Math.round(LUCKY_GIFT_CONFIG.hostEarningPercent || 4.0));
    const hostPoints = (costBigInt * hostPercentBigInt) / 100n;
    return hostPoints > 0n ? hostPoints : 0n;
};

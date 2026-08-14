import prisma from '../config/prisma.js';

const CACHE_LIFETIME = 15 * 60 * 1000; // 15 Minutes
let cachedBannedWords = [];
let lastLoadedTime = 0;

export async function getBannedWords() {
    const now = Date.now();
    
    // If cache is empty, fetch synchronously
    if (cachedBannedWords.length === 0) {
        try {
            console.log("[Censor Utility] Loading initial banned words from DB...");
            const words = await prisma.bannedWord.findMany({
                where: { isActive: true },
                select: { word: true }
            });
            cachedBannedWords = words;
            lastLoadedTime = now;
            console.log(`[Censor Utility] Cached ${words.length} banned words.`);
        } catch (err) {
            console.error("[Censor Utility] Error loading initial banned words:", err);
        }
        return cachedBannedWords;
    }

    // If cache expired, trigger asynchronous background refresh
    if (now - lastLoadedTime >= CACHE_LIFETIME) {
        lastLoadedTime = now; // Prevent concurrent multiple background updates
        setImmediate(async () => {
            try {
                console.log("[Censor Utility] Background refresh starting...");
                const words = await prisma.bannedWord.findMany({
                    where: { isActive: true },
                    select: { word: true }
                });
                cachedBannedWords = words;
                console.log(`[Censor Utility] Background refresh finished. Cached ${words.length} words.`);
            } catch (err) {
                console.error("[Censor Utility] Background refresh error:", err);
            }
        });
    }

    return cachedBannedWords;
}

export function getLevenshteinDistance(s1, s2) {
    s1 = s1.toLowerCase();
    s2 = s2.toLowerCase();
    const costs = [];
    for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
            if (i === 0) {
                costs[j] = j;
            } else {
                if (j > 0) {
                    let newValue = costs[j - 1];
                    if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
                        newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                    }
                    costs[j - 1] = lastValue;
                    lastValue = newValue;
                }
            }
        }
        if (i > 0) {
            costs[s2.length] = lastValue;
        }
    }
    return costs[s2.length];
}

export function getSimilarity(s1, s2) {
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    const longerLength = longer.length;
    if (longerLength === 0) {
        return 1.0;
    }
    return (longerLength - getLevenshteinDistance(longer, shorter)) / longerLength;
}

const SAFE_WORDS = new Set([
    "shut", "beach", "sheet", "came", "duck", "puck", "push", "dock", "much", "such", "rich"
]);

export function censorTextWithFuzzyMatch(text, bannedWords, threshold = 0.7) {
    if (!text || typeof text !== "string") return text;

    const parts = text.split(/(\b)/g);
    
    const processedParts = parts.map(part => {
        if (!/^[a-zA-Z0-9\u0900-\u097F]+$/.test(part)) {
            return part;
        }

        const lowerPart = part.toLowerCase();
        
        if (SAFE_WORDS.has(lowerPart)) {
            return part;
        }
        
        let isBanned = false;
        
        for (const banned of bannedWords) {
            const similarity = getSimilarity(lowerPart, banned.word.toLowerCase());
            if (similarity >= threshold) {
                isBanned = true;
                break;
            }
        }

        if (isBanned) {
            return "*".repeat(part.length);
        }

        return part;
    });

    return processedParts.join("");
}

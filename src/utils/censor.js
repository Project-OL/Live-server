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

/**
 * LIVE-33: the fuzzy censor runs synchronously on the event loop for every chat and call message,
 * comparing each word against every banned word with Levenshtein. Same verdicts as before, cheaper:
 *  - banned words are lowercased once per word list (not per comparison);
 *  - a pair is skipped when it can't reach the threshold: distance >= |len1 - len2|, so
 *    similarity <= shorter / longer; if that bound is below the threshold the result is "no";
 *  - verdicts are memoized per (word list, threshold, word), bounded, since chat repeats words.
 */
const preparedLists = new WeakMap();
const VERDICT_CACHE_MAX = 5000;

const prepareList = (bannedWords, threshold) => {
    let prepared = preparedLists.get(bannedWords);
    if (!prepared) {
        prepared = { words: bannedWords.map((b) => String(b.word ?? "").toLowerCase()), verdicts: new Map() };
        preparedLists.set(bannedWords, prepared);
    }
    let byThreshold = prepared.verdicts.get(threshold);
    if (!byThreshold) {
        byThreshold = new Map();
        prepared.verdicts.set(threshold, byThreshold);
    }
    return { words: prepared.words, verdicts: byThreshold };
};

const isBannedWord = (lowerPart, words, threshold) => {
    for (const w of words) {
        const longer = Math.max(lowerPart.length, w.length);
        if (longer === 0) return 1.0 >= threshold;
        // Upper bound of getSimilarity for this pair; exact pruning, never changes a verdict.
        if (Math.min(lowerPart.length, w.length) / longer < threshold) continue;
        if (getSimilarity(lowerPart, w) >= threshold) return true;
    }
    return false;
};

export function censorTextWithFuzzyMatch(text, bannedWords, threshold = 0.7) {
    if (!text || typeof text !== "string") return text;
    if (!Array.isArray(bannedWords) || bannedWords.length === 0) return text;

    const { words, verdicts } = prepareList(bannedWords, threshold);
    const parts = text.split(/(\b)/g);

    const processedParts = parts.map(part => {
        if (!/^[a-zA-Z0-9\u0900-\u097F]+$/.test(part)) {
            return part;
        }

        const lowerPart = part.toLowerCase();

        if (SAFE_WORDS.has(lowerPart)) {
            return part;
        }

        let isBanned = verdicts.get(lowerPart);
        if (isBanned === undefined) {
            isBanned = isBannedWord(lowerPart, words, threshold);
            if (verdicts.size >= VERDICT_CACHE_MAX) verdicts.clear();
            verdicts.set(lowerPart, isBanned);
        }

        if (isBanned) {
            return "*".repeat(part.length);
        }

        return part;
    });

    return processedParts.join("");
}

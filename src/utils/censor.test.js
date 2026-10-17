import { test } from "node:test";
import assert from "node:assert/strict";
import { censorTextWithFuzzyMatch, getSimilarity } from "./censor.js";

// The pre-LIVE-33 algorithm, verbatim in behaviour, as the reference.
const SAFE = new Set(["shut", "beach", "sheet", "came", "duck", "puck", "push", "dock", "much", "such", "rich"]);
const reference = (text, bannedWords, threshold = 0.7) =>
    text
        .split(/(\b)/g)
        .map((part) => {
            if (!/^[a-zA-Z0-9ऀ-ॿ]+$/.test(part)) return part;
            const lower = part.toLowerCase();
            if (SAFE.has(lower)) return part;
            for (const b of bannedWords) if (getSimilarity(lower, b.word.toLowerCase()) >= threshold) return "*".repeat(part.length);
            return part;
        })
        .join("");

const banned = ["fuck", "shit", "bitch", "bastard", "idiot", "chutiya", "madarchod", "sex", "nude", "porn"].map((word) => ({ word }));

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const randomWord = () => {
    const base = banned[Math.floor(rand() * banned.length)].word;
    const mutate = rand();
    if (mutate < 0.3) return base;
    const chars = base.split("");
    const i = Math.floor(rand() * chars.length);
    if (mutate < 0.5) chars[i] = String.fromCharCode(97 + Math.floor(rand() * 26));
    else if (mutate < 0.7) chars.splice(i, 1);
    else if (mutate < 0.85) chars.splice(i, 0, "x");
    else return Math.random().toString(36).slice(2, 2 + 1 + Math.floor(rand() * 9));
    return rand() < 0.3 ? chars.join("").toUpperCase() : chars.join("");
};

test("LIVE-33: optimized censor gives exactly the reference output", () => {
    for (let n = 0; n < 2000; n++) {
        const text = Array.from({ length: 1 + Math.floor(rand() * 12) }, randomWord).join(rand() < 0.5 ? " " : ", ");
        for (const t of [0.6, 0.7, 0.85]) {
            assert.equal(censorTextWithFuzzyMatch(text, banned, t), reference(text, banned, t), `text=${text} t=${t}`);
        }
    }
    assert.equal(censorTextWithFuzzyMatch("hello world", []), "hello world");
    assert.equal(censorTextWithFuzzyMatch("shut the door", banned), reference("shut the door", banned));
});

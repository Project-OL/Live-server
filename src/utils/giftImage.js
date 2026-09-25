/**
 * Client-facing gift image fields - mirrors ol-node-rest `mapPublicGift`.
 *
 * `displayImageUrl` is what the app draws (grid cells, chat line icons, floating
 * particles - all <= ~55dp), so it gets the 192px WebP thumbnail when one exists.
 * The original (often a 1-2.5 MB PNG) stays available as `fullImageUrl`.
 * Falls back to the original when no thumbnail has been generated yet.
 */
export const giftImageFields = (gift) => ({
    displayImageUrl: gift?.thumbnailUrl || gift?.displayImageUrl || null,
    fullImageUrl: gift?.displayImageUrl || null
});

/** Same, applied to a full gift row (list endpoints return raw rows). */
export const withGiftThumbnail = (gift) => ({ ...gift, ...giftImageFields(gift) });

/**
 * Public id a live room may show for a user, so the app's user card can open a
 * DM (ol-node-rest POST /conversations takes a public id). Mystery (stealth)
 * users never get one: their real id must not leak into the room.
 */
export const roomPublicId = (user) => {
    if (!user) return null;
    if (user.privacyMysteryLive && user.vipSubscriptionActive) return null;
    return user.publicId != null ? String(user.publicId) : null;
};

/**
 * Adds `publicId` to mic-seat entries for the room-detail response. The
 * `stream:sheet:*` hash only stores userId/username (it is also read by admin
 * code in both repos), so the id is resolved here instead of being stored.
 * `lookupPrivacy` is getUserPrivacyService (cached; `isStealth` + `publicId`).
 * A failed lookup leaves that seat without an id rather than failing the room.
 */
export const withSheetPublicIds = async (sheetUsers, lookupPrivacy) => {
    if (!Array.isArray(sheetUsers) || sheetUsers.length === 0) return sheetUsers;
    return Promise.all(sheetUsers.map(async (su) => {
        if (!su || !su.userId || su.publicId) return su;
        try {
            const privacy = await lookupPrivacy({ userId: su.userId });
            return { ...su, publicId: privacy?.isStealth ? null : (privacy?.publicId ?? null) };
        } catch {
            return { ...su, publicId: null };
        }
    }));
};

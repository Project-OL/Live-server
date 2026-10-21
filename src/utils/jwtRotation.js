import jwt from "jsonwebtoken";

/**
 * SEC-01: rotate the JWT secrets shared with ol-node-rest without logging anyone out (mirrors
 * ol-node-rest src/utils/jwt.ts verifyRotating). Verify with the current secret first; only when
 * that fails on the SIGNATURE, try the optional previous secret (JWT_ACCESS_SECRET_PREVIOUS /
 * ADMIN_JWT_SECRET_PREVIOUS). Expiry and every other error come from the current-secret check.
 * With no previous secret set this is plain jwt.verify.
 */
export const verifyRotating = (token, current, previous, options) => {
    try {
        return jwt.verify(token, current, options);
    } catch (err) {
        if (previous && err instanceof jwt.JsonWebTokenError && err.message === "invalid signature") {
            return jwt.verify(token, previous, options);
        }
        throw err;
    }
};

export const previousAccessSecret = () => process.env.JWT_ACCESS_SECRET_PREVIOUS || undefined;
export const previousAdminSecret = () => process.env.ADMIN_JWT_SECRET_PREVIOUS || undefined;

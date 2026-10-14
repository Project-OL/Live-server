import express, { Router } from "express";
import * as controller from "./controller.js";
import auth from "../../middlewares/authMiddleware.js";

const router = Router();

/**
 * SEC-06: local test-page helpers. /test-users mints a signed access token for every user it
 * lists and /reset ends every ringing/active call, both without auth, so they are only
 * registered when LIVE_ENABLE_TEST_ROUTES=true and never in production. ol_app does not call them.
 */
const testRoutesEnabled =
    process.env.NODE_ENV !== "production" &&
    String(process.env.LIVE_ENABLE_TEST_ROUTES || "").toLowerCase() === "true";

if (testRoutesEnabled) {
    console.warn("[SEC-06] Test routes /video-call/test-users and /video-call/reset are ENABLED (non-production only).");
    router.get("/test-users", controller.getTestUsers);
    router.post("/reset", controller.resetActiveCalls);
}

router.post("/initiate", auth, controller.initiateCall);
router.post("/accept", auth, controller.acceptCall);
router.post("/reject", auth, controller.rejectCall);
router.post("/end", auth, controller.endCall);
router.get("/status/:sessionId", auth, controller.getStatus);
router.get("/settings/:creatorId", auth, controller.getCallSettings);

router.post("/heartbeat", auth, controller.heartbeat);
router.post("/verify-frame", auth, controller.verifyFrame);
router.post("/send-gift", auth, controller.sendGift);
router.post("/translate", auth, controller.translateText);
router.get("/gifts", auth, controller.getGifts);

// SEC-07: raw body so the LiveKit signature can be checked (LiveKit sends application/webhook+json).
router.post("/webhook", express.raw({ type: () => true, limit: "1mb" }), controller.livekitWebhook);

export default router;
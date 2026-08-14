import { Router } from "express";
import * as controller from "./controller.js";
import auth from "../../middlewares/authMiddleware.js";

const router = Router();

router.get("/test-users", controller.getTestUsers);
router.post("/reset", controller.resetActiveCalls);

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

router.post("/webhook", controller.livekitWebhook);

export default router;
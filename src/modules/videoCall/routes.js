import { Router } from "express";
import * as controller from "./controller.js";
import auth from "../../middlewares/authMiddleware.js";

const router = Router();

// Phase 3 APIs
router.post("/initiate", auth, controller.initiateCall);
router.post("/accept", auth, controller.acceptCall);
router.post("/reject", auth, controller.rejectCall);
router.post("/end", auth, controller.endCall);
router.get("/status/:sessionId", auth, controller.getStatus);

// Phase 8 Heartbeat
router.post("/heartbeat", auth, controller.heartbeat);

// LiveKit Webhook
router.post("/webhook", controller.livekitWebhook);

export default router;
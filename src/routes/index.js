import { Router } from "express";
import liveRoutes from "./controllers/controllerLive.js";
import adminRoutes, { getMyRestrictions } from "./controllers/controllerAdmin.js";
import auth from "../middlewares/authMiddleware.js";

const router = Router();

router.use("/live-stream", liveRoutes);

router.use("/admin", adminRoutes);
router.use("/v1/admin", adminRoutes);

router.get("/users/me/restrictions", auth, getMyRestrictions);
router.get("/v1/users/me/restrictions", auth, getMyRestrictions);

export default router;
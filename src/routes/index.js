import { Router } from "express";
import liveRoutes from "./controllers/controllerLive.js";
import adminRoutes, { getMyRestrictions } from "./controllers/controllerAdmin.js";
import auth from "../middlewares/authMiddleware.js";

const router = Router();

router.use("/live-stream", liveRoutes);

// Admin Restrictions APIs (/api/v1/admin/users/... & /api/admin/users/...)
router.use("/admin", adminRoutes);
router.use("/v1/admin", adminRoutes);

// User Self Restriction Check (/api/v1/users/me/restrictions & /api/users/me/restrictions)
router.get("/users/me/restrictions", auth, getMyRestrictions);
router.get("/v1/users/me/restrictions", auth, getMyRestrictions);

export default router;
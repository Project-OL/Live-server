import { Router } from "express";
import videoCallRoutes from "./videoCall/routes.js";

const router = Router();

router.use("/video-call", videoCallRoutes);

export default router;
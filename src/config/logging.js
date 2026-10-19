// LIVE-44: imported first by server.js. `dotenv/config` must load before logger.js reads
// LIVE_LOG_LEVEL / LIVE_LOG_FORMAT (ES modules evaluate imports in order).
import "dotenv/config";
import { installConsoleBridge } from "../utils/logger.js";

installConsoleBridge();

// BigInt Serialization Patch
BigInt.prototype.toJSON = function () {
  const num = Number(this);
  return Number.isSafeInteger(num) ? num : this.toString();
};

import http from 'http';
import app from './src/app.js';
import dotenv from 'dotenv';
import { initSocket } from "./src/socket/index.js";

dotenv.config();

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);

// Socket Init
initSocket(server);

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
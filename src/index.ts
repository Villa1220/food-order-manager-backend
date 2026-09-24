import { createServer } from "node:http";
import { app } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db/pool.js";
import { attachSocket } from "./socket.js";
import { setIo } from "./realtime.js";

const httpServer = createServer(app);
const io = attachSocket(httpServer);
setIo(io);

io.on("connection", (socket) => {
  socket.join("kitchen");
});

httpServer.listen(config.port, () => {
  console.log(`API en http://localhost:${config.port}`);
  console.log(`Health: http://localhost:${config.port}/health`);
});

async function shutdown() {
  io.close();
  httpServer.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

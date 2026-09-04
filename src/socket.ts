import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { config } from "./config.js";

export function attachSocket(httpServer: HttpServer) {
  return new Server(httpServer, {
    cors: {
      origin: config.frontendOrigin,
      methods: ["GET", "POST"],
    },
  });
}

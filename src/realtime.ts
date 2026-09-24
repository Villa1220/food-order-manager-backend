import type { Server } from "socket.io";

/**
 * Punto único de acceso al servidor socket.io para que las rutas puedan
 * emitir eventos sin importar el orden de inicialización.
 */
let io: Server | null = null;

export function setIo(server: Server) {
  io = server;
}

/** Emite un evento a la sala "kitchen" (pantalla KDS). */
export function emitToKitchen(event: string, payload: unknown) {
  io?.to("kitchen").emit(event, payload);
}

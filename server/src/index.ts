import { existsSync, readFileSync } from "fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "http";
import { createServer as createHttpsServer } from "https";
import { join } from "path";
import { URL } from "url";
import { createClientId, parseMessage } from "./protocol";
import { RoomManager } from "./roomManager";
import type { BaseMessage, JoinResponse, PollResponse } from "./types";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";
const CLEANUP_INTERVAL_MS = 20_000;
const CERT_DIR = join(process.cwd(), "certs");
const KEY_FILE = process.env.HTTPS_KEY_FILE ?? join(CERT_DIR, "server.key");
const CERT_FILE = process.env.HTTPS_CERT_FILE ?? join(CERT_DIR, "server.crt");

const roomManager = new RoomManager();

function log(message: string, extra?: unknown): void {
  if (extra === undefined) {
    console.log(`[server] ${message}`);
    return;
  }

  console.log(`[server] ${message}`, extra);
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  setCorsHeaders(response);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

async function readBody(request: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => resolve(raw));
    request.on("error", reject);
  });
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function requestHandler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  setCorsHeaders(response);

  if (!request.url || !request.method) {
    sendJson(response, 400, { ok: false, error: "Invalid request" });
    return;
  }

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }

  const forwardedProto = request.headers["x-forwarded-proto"];
  const protocol = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto || (isHttpsConfigured() ? "https" : "http");
  const requestUrl = new URL(request.url, `${protocol}://${request.headers.host ?? `${HOST}:${PORT}`}`);
  const pathname = requestUrl.pathname;

  if (request.method === "GET" && pathname === "/health") {
    sendJson(response, 200, { ok: true, protocol: isHttpsConfigured() ? "https-polling" : "http-polling" });
    return;
  }

  if (request.method === "POST" && pathname === "/rooms/join") {
    const raw = await readBody(request);
    const body = parseJson<{
      roomId?: string;
      clientId?: string;
      videoKey?: BaseMessage["videoKey"];
      sinceEventId?: number;
      takeoverMaster?: boolean;
    }>(raw);
    const roomId = body?.roomId?.trim();

    if (!roomId) {
      sendJson(response, 400, { ok: false, error: "roomId is required" });
      return;
    }

    const clientId = body?.clientId?.trim() || createClientId();
    const videoKey = body?.videoKey ?? { url: "" };
    const sinceEventId = Number.isFinite(body?.sinceEventId) ? Number(body?.sinceEventId) : 0;
    const takeoverMaster = body?.takeoverMaster === true;
    const room = roomManager.joinRoom(roomId, clientId, videoKey, takeoverMaster);

    const payload: JoinResponse = {
      ok: true,
      clientId,
      roomId,
      masterId: room.masterId,
      events: roomManager.poll(roomId, clientId, sinceEventId)
    };

    log(`client ${clientId} joined room ${roomId}`);
    sendJson(response, 200, payload);
    return;
  }

  if (request.method === "POST" && pathname === "/rooms/leave") {
    const raw = await readBody(request);
    const body = parseJson<{ roomId?: string; clientId?: string; videoKey?: BaseMessage["videoKey"] }>(raw);
    const roomId = body?.roomId?.trim();
    const clientId = body?.clientId?.trim();

    if (!roomId || !clientId) {
      sendJson(response, 400, { ok: false, error: "roomId and clientId are required" });
      return;
    }

    roomManager.leaveRoom(roomId, clientId, body?.videoKey ?? { url: "" });
    log(`client ${clientId} left room ${roomId}`);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && pathname === "/rooms/poll") {
    const roomId = requestUrl.searchParams.get("roomId")?.trim();
    const clientId = requestUrl.searchParams.get("clientId")?.trim();
    const since = Number(requestUrl.searchParams.get("since") ?? "0");

    if (!roomId || !clientId) {
      sendJson(response, 400, { ok: false, error: "roomId and clientId are required" });
      return;
    }

    const room = roomManager.getRoom(roomId);
    const payload: PollResponse = {
      ok: true,
      roomId,
      clientId,
      masterId: room?.masterId ?? null,
      events: roomManager.poll(roomId, clientId, Number.isFinite(since) ? since : 0)
    };

    sendJson(response, 200, payload);
    return;
  }

  if (request.method === "POST" && pathname === "/rooms/events") {
    const raw = await readBody(request);
    const message = parseMessage(raw);

    if (!message) {
      sendJson(response, 400, { ok: false, error: "Invalid message payload" });
      return;
    }

    const result = roomManager.publish(message.roomId, message.senderId, message);
    if (!result.ok) {
      sendJson(response, 400, { ok: false, error: result.error });
      return;
    }

    log(`event ${message.type} from ${message.senderId} in room ${message.roomId}`);
    sendJson(response, 200, { ok: true, masterId: result.room?.masterId ?? null });
    return;
  }

  sendJson(response, 404, { ok: false, error: "Not found" });
}

function isHttpsConfigured(): boolean {
  return existsSync(KEY_FILE) && existsSync(CERT_FILE);
}

const server = isHttpsConfigured()
  ? createHttpsServer(
      {
        key: readFileSync(KEY_FILE),
        cert: readFileSync(CERT_FILE)
      },
      (request, response) => {
        void requestHandler(request, response);
      }
    )
  : createHttpServer((request, response) => {
      void requestHandler(request, response);
    });

const cleanupTimer = setInterval(() => {
  roomManager.cleanupStaleMembers();
}, CLEANUP_INTERVAL_MS);

server.listen(PORT, HOST, () => {
  if (isHttpsConfigured()) {
    log(`HTTPS polling server listening on https://${HOST}:${PORT}`);
    log(`Using certificate files: key=${KEY_FILE}, cert=${CERT_FILE}`);
  } else {
    log(`HTTP polling server listening on http://${HOST}:${PORT}`);
    log(`HTTPS disabled because cert files were not found at ${KEY_FILE} and ${CERT_FILE}`);
  }
});

server.on("close", () => {
  clearInterval(cleanupTimer);
});

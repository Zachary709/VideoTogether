import { randomUUID } from "crypto";
import type { BaseMessage, MessageType, SyncPayload, VideoKey } from "./types";

export const DEFAULT_VIDEO_KEY: VideoKey = {
  url: ""
};

export function createServerMessage(
  type: MessageType,
  roomId: string,
  senderId: string,
  videoKey: VideoKey = DEFAULT_VIDEO_KEY,
  payload?: SyncPayload
): BaseMessage {
  return {
    type,
    roomId,
    senderId,
    timestamp: Date.now(),
    videoKey,
    payload
  };
}

export function parseMessage(raw: string): BaseMessage | null {
  try {
    const parsed = JSON.parse(raw) as Partial<BaseMessage>;
    if (
      !parsed ||
      typeof parsed.type !== "string" ||
      typeof parsed.roomId !== "string" ||
      typeof parsed.senderId !== "string" ||
      typeof parsed.timestamp !== "number" ||
      !parsed.videoKey ||
      typeof parsed.videoKey.url !== "string"
    ) {
      return null;
    }

    return {
      type: parsed.type as MessageType,
      roomId: parsed.roomId,
      senderId: parsed.senderId,
      timestamp: parsed.timestamp,
      videoKey: parsed.videoKey,
      payload: parsed.payload
    };
  } catch {
    return null;
  }
}

export function createClientId(): string {
  return `client_${randomUUID()}`;
}

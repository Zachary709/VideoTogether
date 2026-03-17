export type MessageType =
  | "join"
  | "leave"
  | "state"
  | "play"
  | "pause"
  | "seek"
  | "changePart"
  | "ping"
  | "pong"
  | "masterChanged"
  | "error";

export interface VideoKey {
  bvid?: string;
  p?: number;
  url: string;
}

export interface SyncPayload {
  currentTime?: number;
  paused?: boolean;
  targetUrl?: string;
  message?: string;
  masterId?: string | null;
  requestedBy?: string;
  clientId?: string;
}

export interface BaseMessage {
  type: MessageType;
  roomId: string;
  senderId: string;
  timestamp: number;
  videoKey: VideoKey;
  payload?: SyncPayload;
}

export interface Member {
  id: string;
  joinedAt: number;
  lastSeenAt: number;
}

export interface RoomEvent extends BaseMessage {
  id: number;
}

export interface Room {
  id: string;
  members: Map<string, Member>;
  masterId: string | null;
  events: RoomEvent[];
  nextEventId: number;
}

export interface JoinResponse {
  ok: true;
  clientId: string;
  roomId: string;
  masterId: string | null;
  events: RoomEvent[];
}

export interface PollResponse {
  ok: true;
  roomId: string;
  clientId: string;
  masterId: string | null;
  events: RoomEvent[];
}

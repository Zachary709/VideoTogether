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
  epId?: string;
  seasonId?: string;
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
  sentAt?: number;
  playbackRate?: number;
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

export interface PlaybackSnapshot {
  clientId: string;
  roomId: string;
  videoKey: VideoKey;
  currentTime: number;
  paused: boolean;
  playbackRate: number;
  reportedAt: number;
}

export interface SyncInstruction {
  targetUrl?: string;
  videoKey: VideoKey;
  currentTime: number;
  paused: boolean;
  playbackRate: number;
  reportedAt: number;
  reason: "ready" | "drift" | "followMaster";
}

export interface Room {
  id: string;
  members: Map<string, Member>;
  masterId: string | null;
  events: RoomEvent[];
  nextEventId: number;
  playbackSnapshots: Map<string, PlaybackSnapshot>;
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

export interface ReportStateResponse {
  ok: true;
  roomId: string;
  clientId: string;
  masterId: string | null;
  syncInstruction: SyncInstruction | null;
}
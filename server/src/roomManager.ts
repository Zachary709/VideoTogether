import { createServerMessage } from "./protocol";
import type { BaseMessage, Member, PlaybackSnapshot, Room, RoomEvent, SyncInstruction, VideoKey } from "./types";

const MAX_EVENTS_PER_ROOM = 200;
const MEMBER_STALE_MS = 70_000;
const DRIFT_THRESHOLD_SEC = 1.0;
const READY_THRESHOLD_SEC = 0.3;

export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  joinRoom(roomId: string, clientId: string, videoKey: VideoKey, takeoverMaster = false): Room {
    const room = this.getOrCreateRoom(roomId);
    const now = Date.now();
    const existing = room.members.get(clientId);

    const member: Member = existing ?? {
      id: clientId,
      joinedAt: now,
      lastSeenAt: now
    };

    member.lastSeenAt = now;
    room.members.set(clientId, member);

    const existingSnapshot = room.playbackSnapshots.get(clientId);
    if (existingSnapshot) {
      existingSnapshot.videoKey = videoKey;
      existingSnapshot.reportedAt = now;
      room.playbackSnapshots.set(clientId, existingSnapshot);
    }

    if (!room.masterId || takeoverMaster) {
      const masterChanged = room.masterId !== clientId;
      room.masterId = clientId;
      if (masterChanged) {
        this.pushEvent(
          room,
          createServerMessage("masterChanged", roomId, "server", { url: "" }, { masterId: clientId, requestedBy: clientId })
        );
      }
    }

    this.pushEvent(room, createServerMessage("join", roomId, clientId, videoKey));
    return room;
  }

  leaveRoom(roomId: string, clientId: string, videoKey: VideoKey): Room | null {
    const room = this.rooms.get(roomId);
    if (!room) {
      return null;
    }

    const existed = room.members.delete(clientId);
    room.playbackSnapshots.delete(clientId);
    if (!existed) {
      return room;
    }

    this.pushEvent(room, createServerMessage("leave", roomId, clientId, videoKey));

    if (room.masterId === clientId) {
      room.masterId = this.pickNextMaster(room);
      this.pushEvent(
        room,
        createServerMessage("masterChanged", roomId, "server", { url: "" }, { masterId: room.masterId })
      );
    }

    this.deleteRoomIfEmpty(room);
    return room;
  }

  requestMaster(roomId: string, clientId: string): Room | null {
    const room = this.rooms.get(roomId);
    if (!room || !room.members.has(clientId)) {
      return null;
    }

    room.masterId = clientId;
    this.touch(roomId, clientId);
    this.pushEvent(
      room,
      createServerMessage("masterChanged", roomId, "server", { url: "" }, { masterId: clientId, requestedBy: clientId })
    );
    return room;
  }

  reportState(
    roomId: string,
    clientId: string,
    snapshot: PlaybackSnapshot,
    readyForSync = false
  ): { ok: boolean; error?: string; room?: Room; syncInstruction?: SyncInstruction | null } {
    const room = this.rooms.get(roomId);
    if (!room) {
      return { ok: false, error: "Room not found" };
    }

    if (!room.members.has(clientId)) {
      return { ok: false, error: "Client is not in the room" };
    }

    this.touch(roomId, clientId);
    room.playbackSnapshots.set(clientId, snapshot);

    if (!room.masterId || clientId === room.masterId) {
      return { ok: true, room, syncInstruction: null };
    }

    const masterSnapshot = room.playbackSnapshots.get(room.masterId);
    if (!masterSnapshot) {
      return { ok: true, room, syncInstruction: null };
    }

    return {
      ok: true,
      room,
      syncInstruction: this.createSyncInstruction(masterSnapshot, snapshot, readyForSync)
    };
  }

  publish(roomId: string, clientId: string, message: BaseMessage): { ok: boolean; error?: string; room?: Room } {
    const room = this.rooms.get(roomId);
    if (!room) {
      return { ok: false, error: "Room not found" };
    }

    if (!room.members.has(clientId)) {
      return { ok: false, error: "Client is not in the room" };
    }

    this.touch(roomId, clientId);

    if (message.type === "state" && message.payload?.requestedBy === "requestMaster") {
      const updatedRoom = this.requestMaster(roomId, clientId);
      if (!updatedRoom) {
        return { ok: false, error: "Failed to switch master" };
      }
      return { ok: true, room: updatedRoom };
    }

    if (room.masterId !== clientId) {
      return { ok: false, error: "Only the master can publish sync events" };
    }

    this.updateSnapshotFromMessage(room, clientId, message);
    this.pushEvent(room, message);
    return { ok: true, room };
  }

  poll(roomId: string, clientId: string, sinceEventId: number): RoomEvent[] {
    const room = this.rooms.get(roomId);
    if (!room) {
      return [];
    }

    this.touch(roomId, clientId);
    return room.events.filter((event) => event.id > sinceEventId && event.senderId !== clientId);
  }

  touch(roomId: string, clientId: string): void {
    const room = this.rooms.get(roomId);
    const member = room?.members.get(clientId);
    if (member) {
      member.lastSeenAt = Date.now();
    }
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  cleanupStaleMembers(): void {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      const staleMembers = [...room.members.values()].filter((member) => now - member.lastSeenAt > MEMBER_STALE_MS);

      for (const member of staleMembers) {
        room.members.delete(member.id);
        room.playbackSnapshots.delete(member.id);
        this.pushEvent(room, createServerMessage("leave", room.id, member.id, { url: "" }));
        if (room.masterId === member.id) {
          room.masterId = this.pickNextMaster(room);
          this.pushEvent(
            room,
            createServerMessage("masterChanged", room.id, "server", { url: "" }, { masterId: room.masterId })
          );
        }
      }

      this.deleteRoomIfEmpty(room);
    }
  }

  private getOrCreateRoom(roomId: string): Room {
    const existing = this.rooms.get(roomId);
    if (existing) {
      return existing;
    }

    const room: Room = {
      id: roomId,
      members: new Map(),
      masterId: null,
      events: [],
      nextEventId: 1,
      playbackSnapshots: new Map()
    };
    this.rooms.set(roomId, room);
    return room;
  }

  private pushEvent(room: Room, message: BaseMessage): void {
    const event: RoomEvent = {
      id: room.nextEventId++,
      ...message
    };
    room.events.push(event);

    if (room.events.length > MAX_EVENTS_PER_ROOM) {
      room.events.splice(0, room.events.length - MAX_EVENTS_PER_ROOM);
    }
  }

  private pickNextMaster(room: Room): string | null {
    const nextMember = [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    return nextMember?.id ?? null;
  }

  private deleteRoomIfEmpty(room: Room): void {
    if (room.members.size === 0) {
      this.rooms.delete(room.id);
    }
  }

  private createSyncInstruction(
    masterSnapshot: PlaybackSnapshot,
    followerSnapshot: PlaybackSnapshot,
    readyForSync: boolean
  ): SyncInstruction | null {
    const sameContent = this.isSameVideoKey(masterSnapshot.videoKey, followerSnapshot.videoKey);
    const now = Date.now();
    const masterNow = this.estimateCurrentTime(masterSnapshot, now);
    const followerNow = this.estimateCurrentTime(followerSnapshot, now);
    const threshold = readyForSync ? READY_THRESHOLD_SEC : DRIFT_THRESHOLD_SEC;
    const playbackStateChanged = masterSnapshot.paused !== followerSnapshot.paused;

    if (!sameContent) {
      return {
        targetUrl: masterSnapshot.videoKey.url,
        videoKey: masterSnapshot.videoKey,
        currentTime: masterNow,
        paused: masterSnapshot.paused,
        playbackRate: masterSnapshot.playbackRate,
        reportedAt: now,
        reason: "followMaster"
      };
    }

    if (readyForSync || playbackStateChanged || Math.abs(masterNow - followerNow) > threshold) {
      return {
        targetUrl: masterSnapshot.videoKey.url,
        videoKey: masterSnapshot.videoKey,
        currentTime: masterNow,
        paused: masterSnapshot.paused,
        playbackRate: masterSnapshot.playbackRate,
        reportedAt: now,
        reason: readyForSync ? "ready" : "drift"
      };
    }

    return null;
  }

  private estimateCurrentTime(snapshot: PlaybackSnapshot, now: number): number {
    if (snapshot.paused) {
      return snapshot.currentTime;
    }

    const deltaSec = Math.max(0, now - snapshot.reportedAt) / 1000;
    return snapshot.currentTime + deltaSec * snapshot.playbackRate;
  }

  private isSameVideoKey(left: VideoKey, right: VideoKey): boolean {
    if (left.epId && right.epId) {
      return left.epId === right.epId;
    }

    if (left.bvid && right.bvid) {
      return left.bvid === right.bvid && (left.p ?? 1) === (right.p ?? 1);
    }

    return left.url === right.url;
  }

  private updateSnapshotFromMessage(room: Room, clientId: string, message: BaseMessage): void {
    const current = room.playbackSnapshots.get(clientId);
    const now = typeof message.timestamp === "number" ? message.timestamp : Date.now();
    const currentTime = typeof message.payload?.currentTime === "number"
      ? message.payload.currentTime
      : current?.currentTime ?? 0;
    const paused = this.resolvePausedState(message, current);
    const playbackRate = typeof message.payload?.playbackRate === "number" && Number.isFinite(message.payload.playbackRate)
      ? message.payload.playbackRate
      : current?.playbackRate ?? 1;
    const nextVideoKey = this.resolveVideoKeyFromMessage(message, current?.videoKey);

    room.playbackSnapshots.set(clientId, {
      clientId,
      roomId: room.id,
      videoKey: nextVideoKey,
      currentTime,
      paused,
      playbackRate,
      reportedAt: now
    });
  }

  private resolvePausedState(message: BaseMessage, current?: PlaybackSnapshot): boolean {
    if (message.type === "play") return false;
    if (message.type === "pause") return true;
    if (typeof message.payload?.paused === "boolean") return message.payload.paused;
    return current?.paused ?? true;
  }

  private resolveVideoKeyFromMessage(message: BaseMessage, fallback?: VideoKey): VideoKey {
    if (message.type === "changePart" && typeof message.payload?.targetUrl === "string" && message.payload.targetUrl) {
      return {
        ...(message.videoKey ?? fallback ?? { url: "" }),
        url: message.payload.targetUrl
      };
    }

    if (message.videoKey && typeof message.videoKey.url === "string") {
      return message.videoKey;
    }

    return fallback ?? { url: "" };
  }
}
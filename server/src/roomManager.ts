import { createServerMessage } from "./protocol";
import type { BaseMessage, Member, Room, RoomEvent, VideoKey } from "./types";

const MAX_EVENTS_PER_ROOM = 200;
const MEMBER_STALE_MS = 70_000;

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
      nextEventId: 1
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
}

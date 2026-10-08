import type { Room } from "./room";

/** State kept per live room (a limiter, its sockets…), dropped when the room is removed. */
export interface PerRoom<T> {
  /** The room's state, created on first use. A room that is not registered gets a fresh value that is never stored. */
  get(room: Room): T;
  /** The room's state if it has any; never creates it. */
  peek(room: Room): T | undefined;
  /** Forgets the room's state (e.g. its last socket left); the next `get` builds it afresh. */
  drop(room: Room): void;
  readonly size: number;
}

/**
 * The live rooms, and every piece of state kept per room. Rooms come and go at run time (M5), so
 * per-room state lives in `perRoom` maps the registry owns: `removeRoom` is the one place a room
 * ends, and it drops every entry (threat model §0 / §7 #2).
 */
export class RoomRegistry {
  private readonly byId = new Map<string, Room>();
  private readonly maps: Map<Room, unknown>[] = [];
  private readonly closers: ((room: Room) => void)[] = [];

  get size(): number {
    return this.byId.size;
  }

  get(id: string): Room | undefined {
    return this.byId.get(id);
  }

  has(room: Room): boolean {
    return this.byId.get(room.id) === room;
  }

  values(): IterableIterator<Room> {
    return this.byId.values();
  }

  /** Registers a room; throws if its id is taken. */
  addRoom(room: Room): void {
    if (this.byId.has(room.id)) throw new Error(`room ${room.id} already exists`);
    this.byId.set(room.id, room);
  }

  /**
   * Ends a room: unregisters it (new upgrades and shares get 404), runs every `onRemove` hook (the
   * WebSocket layer closes the room's sockets and revokes their share grants), then drops every
   * per-room entry. False if the room was not registered.
   */
  removeRoom(room: Room): boolean {
    if (!this.has(room)) return false;
    this.byId.delete(room.id);
    for (const close of this.closers) close(room);
    for (const map of this.maps) map.delete(room);
    return true;
  }

  /** Runs `close(room)` whenever a room is removed, before its per-room state is dropped. */
  onRemove(close: (room: Room) => void): void {
    this.closers.push(close);
  }

  /** A per-room map whose entries `removeRoom` drops. `make` builds a room's state on first use. */
  perRoom<T>(make: (room: Room) => T): PerRoom<T> {
    const map = new Map<Room, T>();
    this.maps.push(map);
    return {
      get: (room) => {
        let value = map.get(room);
        if (value !== undefined) return value;
        value = make(room);
        // A late caller (an in-flight share, a socket opening as its room goes) must not resurrect it.
        if (this.has(room)) map.set(room, value);
        return value;
      },
      peek: (room) => map.get(room),
      drop: (room) => {
        map.delete(room);
      },
      get size() {
        return map.size;
      },
    };
  }

  /** Entries in each per-room map, in creation order. Tests compare it with a baseline. */
  perRoomSizes(): number[] {
    return this.maps.map((m) => m.size);
  }
}

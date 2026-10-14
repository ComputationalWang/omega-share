import type { ControlPolicy, MemberId, RoomLayout, ServerMessage } from "@omega/shared";
import { logError } from "./log";
import type { Room } from "./room";
import type { Conn } from "./ws-sessions";

interface OwnerEditsDeps {
  publish: (topic: string, data: string) => void;
  /** Writes an owner's edit through to the store; throws if it can't, and then nothing changes. */
  persistLayout: (room: Room, layout: RoomLayout) => void;
  persistTitle: (room: Room, title: string) => void;
  persistControlPolicy: (room: Room, policy: ControlPolicy) => void;
  /** ROOM_TITLE_BLOCKLIST, as `POST /rooms` applies it: a rename can't get round it. */
  titleBlocked: (title: string) => boolean;
}

const encode = (msg: ServerMessage): string => JSON.stringify(msg);

/** An owner's room edits (ADR 0028 §6, ADR 0030 §4), store first; the caller has checked owner and bucket. */
export function createOwnerEdits({ publish, persistLayout, persistTitle, persistControlPolicy, titleBlocked }: OwnerEditsDeps) {
  /** Store first: if the write fails nothing changes, so memory never runs ahead of the DB. */
  const persisted = (event: "store.layout" | "store.title" | "store.control_policy", write: () => void): boolean => {
    try {
      write();
      return true;
    } catch (err) {
      logError(event, err);
      return false;
    }
  };
  return {
    /** Last write wins; seats keep their indices, so nobody is unseated (ADR 0028 §6). */
    setLayout(room: Room, by: MemberId, layout: RoomLayout): void {
      if (JSON.stringify(layout) === JSON.stringify(room.layout)) return;
      if (!persisted("store.layout", () => {
        persistLayout(room, layout);
      })) return;
      room.setLayout(layout);
      publish(room.topic, encode({ type: "layout-changed", layout, by }));
    },
    setTitle(ws: Conn, room: Room, by: MemberId, title: string): void {
      if (title === room.title) return;
      if (titleBlocked(title)) {
        // A valid frame, so it doesn't count toward 4400; the contract has no closer code.
        ws.send(encode({ type: "error", code: "bad_message", message: "that title isn't allowed" }));
        return;
      }
      if (!persisted("store.title", () => {
        persistTitle(room, title);
      })) return;
      room.setTitle(title);
      publish(room.topic, encode({ type: "title-changed", title, by }));
    },
    setControlPolicy(room: Room, by: MemberId, policy: ControlPolicy): void {
      if (policy === room.controlPolicy) return;
      if (!persisted("store.control_policy", () => {
        persistControlPolicy(room, policy);
      })) return;
      room.setControlPolicy(policy);
      publish(room.topic, encode({ type: "control-policy-changed", policy, by }));
    },
  };
}

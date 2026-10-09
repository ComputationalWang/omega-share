import type { EmoteKind, MemberId } from "@omega/shared";
import type { ClockSync } from "./clock";
import type { ConnectionEvent } from "./connection";
import type { ShareTokenTracker } from "./share-token";
import type { ViewEvent } from "./state";

export interface RoomEventSinks {
  readonly clock: Pick<ClockSync, "onPong" | "stop">;
  readonly shareToken: Pick<ShareTokenTracker, "onEvent">;
  /** The snapshot arrived: the join went through. */
  readonly joined: () => void;
  /** We were kicked (4005): remember it and say when the rejoin cooldown ends (kick-memory.ts), client ms. */
  readonly kicked: () => number;
  readonly dispatch: (e: ViewEvent) => void;
  /** Someone emoted (OME-415): straight to the scene; emotes are never view state. */
  readonly emoted: (memberId: MemberId, kind: EmoteKind) => void;
}

/** Where one connection event goes. A drop, a closed room (4004) or a kick (4005) stops the clock's pings until the next open. */
export function routeConnectionEvent(e: ConnectionEvent, sinks: RoomEventSinks, now: number): void {
  sinks.shareToken.onEvent(e);
  if (e.type === "message") {
    if (e.msg.type === "pong") sinks.clock.onPong(e.msg.id, e.msg.at);
    else if (e.msg.type === "emoted") sinks.emoted(e.msg.memberId, e.msg.kind);
    else {
      if (e.msg.type === "snapshot") sinks.joined();
      sinks.dispatch({ type: "server", msg: e.msg, now });
    }
    return;
  }
  if (e.type === "disconnected" || e.type === "room-closed" || e.type === "kicked") sinks.clock.stop();
  sinks.dispatch(e.type === "kicked" ? { type: "kicked", until: sinks.kicked() } : e);
}

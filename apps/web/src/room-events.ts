import type { ClockSync } from "./clock";
import type { ConnectionEvent } from "./connection";
import type { ShareTokenTracker } from "./share-token";
import type { ViewEvent } from "./state";

export interface RoomEventSinks {
  readonly clock: Pick<ClockSync, "onPong" | "stop">;
  readonly shareToken: Pick<ShareTokenTracker, "onEvent">;
  /** The snapshot arrived: the join went through. */
  readonly joined: () => void;
  readonly dispatch: (e: ViewEvent) => void;
}

/** Where one connection event goes. A drop or a closed room (4004) stops the clock's pings until the next open. */
export function routeConnectionEvent(e: ConnectionEvent, sinks: RoomEventSinks, now: number): void {
  sinks.shareToken.onEvent(e);
  if (e.type === "message") {
    if (e.msg.type === "pong") sinks.clock.onPong(e.msg.id, e.msg.at);
    else {
      if (e.msg.type === "snapshot") sinks.joined();
      sinks.dispatch({ type: "server", msg: e.msg, now });
    }
    return;
  }
  if (e.type === "disconnected" || e.type === "room-closed") sinks.clock.stop();
  sinks.dispatch(e);
}

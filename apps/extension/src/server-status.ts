import type { RoomsProbe } from "./rooms";

export interface StatusInput {
  readonly origin: string;
  /** `permissions.contains` for the origin's host pattern. */
  readonly permitted: boolean;
  readonly probe: RoomsProbe;
  /** A share token was read for the selected room. */
  readonly hasToken: boolean;
}

export interface ServerStatus {
  /** `null`: nothing to say, the popup hides the status line. */
  readonly message: string | null;
  readonly canShare: boolean;
  /** Show the "open Options" button next to the message. */
  readonly openOptions: boolean;
}

/** The popup's server status line and Share state (research OME-119 §5.4). */
export function serverStatus({ origin, permitted, probe, hasToken }: StatusInput): ServerStatus {
  if (!permitted) return { message: `Allow access to ${origin} in Options.`, canShare: false, openOptions: true };
  switch (probe.kind) {
    case "unreachable":
      return off(`Can't reach ${origin}. Is the tunnel running?`);
    case "offline":
      return off(`The server at ${origin} isn't answering. The tunnel may be offline.`);
    case "sign-in":
      return off("Sign in to the room in a browser tab first.");
    case "ok":
      return hasToken ? { message: null, canShare: true, openOptions: false } : off("Open the room in a tab to share into it.");
  }
}

function off(message: string): ServerStatus {
  return { message, canShare: false, openOptions: false };
}

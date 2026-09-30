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

/** Status wording, shared with the share call's errors so both say the same thing. */
export const STATUS_TEXT = {
  permission: (origin: string): string => `Allow access to ${origin} in Options.`,
  unreachable: (origin: string): string => `Can't reach ${origin}. Is the tunnel running?`,
  offline: (origin: string): string => `The server at ${origin} isn't answering. The tunnel may be offline.`,
  signIn: "Sign in to the room in a browser tab first.",
  noToken: "Open the room in a tab to share into it.",
  tokenRejected: "The room didn't accept this share. Reload the room tab and try again.",
} as const;

/** The popup's server status line and Share state (research OME-119 §5.4). */
export function serverStatus({ origin, permitted, probe, hasToken }: StatusInput): ServerStatus {
  if (!permitted) return { message: STATUS_TEXT.permission(origin), canShare: false, openOptions: true };
  switch (probe.kind) {
    case "unreachable":
      return off(STATUS_TEXT.unreachable(origin));
    case "offline":
      return off(STATUS_TEXT.offline(origin));
    case "sign-in":
      return off(STATUS_TEXT.signIn);
    case "ok":
      return hasToken ? { message: null, canShare: true, openOptions: false } : off(STATUS_TEXT.noToken);
  }
}

function off(message: string): ServerStatus {
  return { message, canShare: false, openOptions: false };
}

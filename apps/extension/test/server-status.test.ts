import { describe, expect, test } from "bun:test";
import { serverStatus, type StatusInput } from "../src/server-status";

const ORIGIN = "https://abc123.ngrok-free.app";
const OK = { kind: "ok", list: { rooms: [{ id: "lobby", label: "lobby (1)" }], selected: "lobby" } } as const;

describe("serverStatus (research OME-119 §5.4)", () => {
  const rows: readonly { name: string; input: StatusInput; message: string | null; canShare: boolean; openOptions: boolean }[] = [
    {
      name: "no host permission for the origin",
      input: { origin: ORIGIN, permitted: false, probe: OK, hasToken: true },
      message: `Allow access to ${ORIGIN} in Options.`,
      canShare: false,
      openOptions: true,
    },
    {
      name: "fetch threw",
      input: { origin: ORIGIN, permitted: true, probe: { kind: "unreachable" }, hasToken: true },
      message: `Can't reach ${ORIGIN}. Is the tunnel running?`,
      canShare: false,
      openOptions: false,
    },
    {
      name: "non-2xx or off-contract answer",
      input: { origin: ORIGIN, permitted: true, probe: { kind: "offline" }, hasToken: true },
      message: `The server at ${ORIGIN} isn't answering. The tunnel may be offline.`,
      canShare: false,
      openOptions: false,
    },
    {
      name: "edge gate wants a sign-in",
      input: { origin: ORIGIN, permitted: true, probe: { kind: "sign-in" }, hasToken: true },
      message: "Sign in to the room in a browser tab first.",
      canShare: false,
      openOptions: false,
    },
    {
      name: "server fine but no room tab / token",
      input: { origin: ORIGIN, permitted: true, probe: OK, hasToken: false },
      message: "Open the room in a tab to share into it.",
      canShare: false,
      openOptions: false,
    },
    {
      name: "server fine and a token",
      input: { origin: ORIGIN, permitted: true, probe: OK, hasToken: true },
      message: null,
      canShare: true,
      openOptions: false,
    },
  ];
  for (const r of rows) {
    test(r.name, () => {
      expect(serverStatus(r.input)).toEqual({ message: r.message, canShare: r.canShare, openOptions: r.openOptions });
    });
  }

  test("a missing permission wins over every probe outcome", () => {
    for (const probe of [OK, { kind: "unreachable" }, { kind: "offline" }, { kind: "sign-in" }] as const) {
      expect(serverStatus({ origin: ORIGIN, permitted: false, probe, hasToken: false }).openOptions).toBe(true);
    }
  });
});

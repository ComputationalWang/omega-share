import { afterEach, describe, expect, test } from "bun:test";
import { AVATAR_COUNT } from "@omega/shared";
import { Client, start, type TestServer } from "./helpers";

// OME-2133: `join.avatarAuto` landed after the Rust switch; the frozen TS server keeps the sent avatar, so every
// test here runs against the binary only.
const binaryOnly = test.skipIf(process.env["OMEGA_SERVER_BIN"] === undefined);

let t: TestServer | null = null;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.server.stop(true);
  t = null;
});

function fail(): never {
  throw new Error("no server");
}
async function join(nickname: string, extra: Record<string, unknown> = {}) {
  const client = await Client.open((t ?? fail()).ws());
  clients.push(client);
  client.send({ type: "join", nickname, avatar: 0, ...extra });
  const snapshot = await client.next("snapshot");
  const self = snapshot.room.members.find((m) => m.id === snapshot.self);
  return { client, avatar: self?.avatar };
}

describe("avatarAuto (OME-2133)", () => {
  binaryOnly("sequential fresh joiners get distinct avatars, then a least-used one", async () => {
    t = start();
    const first = [];
    for (let i = 0; i < AVATAR_COUNT; i++) first.push((await join(`guest${String(i)}`, { avatarAuto: true })).avatar);
    expect(new Set(first).size).toBe(AVATAR_COUNT);
    // One more on avatar 0 by choice: a fifth fresh joiner gets one of the others, each worn once.
    await join("chooser", { avatar: 0 });
    const fifth = (await join("guest4", { avatarAuto: true })).avatar;
    expect(fifth).not.toBe(0);
  });

  binaryOnly("without the flag the sent avatar stands, even if it is worn", async () => {
    t = start();
    expect((await join("alice", { avatar: 2 })).avatar).toBe(2);
    expect((await join("bob", { avatar: 2 })).avatar).toBe(2);
    expect((await join("carol", { avatar: 2, avatarAuto: true })).avatar).not.toBe(2);
  });
});

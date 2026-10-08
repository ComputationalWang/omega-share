import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_LAYOUT } from "@omega/shared";
import { Client, start, type TestServer } from "./helpers";

// ADR 0028: layout-set and title-set are owner-only. Until rooms can be created, no member is an owner.

let t: TestServer | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await t?.server.stop(true);
  t = undefined;
});

async function join(server: TestServer, nickname: string) {
  const r = await Client.join(server.ws(), nickname);
  clients.push(r.client);
  return r;
}

describe("owner-only messages before room ownership exists", () => {
  test("a joined member's layout-set and title-set get not_owner and change nothing", async () => {
    t = start();
    const a = await join(t, "alice");
    const b = await join(t, "bob");
    a.client.send({ type: "layout-set", layout: DEFAULT_LAYOUT });
    expect((await a.client.next("error")).code).toBe("not_owner");
    a.client.send({ type: "title-set", title: "Friday films" });
    expect((await a.client.next("error")).code).toBe("not_owner");
    await b.client.none("layout-changed", 100);
    await b.client.none("title-changed", 0);
  });

  test("the snapshot never says a member is the owner", async () => {
    t = start();
    const a = await join(t, "alice");
    expect(a.snapshot.owner).toBeUndefined();
  });

  test("before join they are refused with not_joined", async () => {
    t = start();
    const c = await Client.open(t.ws());
    clients.push(c);
    c.send({ type: "title-set", title: "Friday films" });
    expect((await c.next("error")).code).toBe("not_joined");
  });
});

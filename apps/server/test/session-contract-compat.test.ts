import { expect, test } from "bun:test";
import { Client, start } from "./helpers";

test("before durable runtime rollout, a resume attempt fails closed without allocating a fresh member", async () => {
  const t = start();
  const client = await Client.open(t.ws());
  try {
    client.send({ type: "join", nickname: "Alice", avatar: 0, resumeToken: "a".repeat(43) });
    expect((await client.next("error")).code).toBe("resume_expired");
    client.send({ type: "join", nickname: "Alice", avatar: 0 });
    expect((await client.next("snapshot")).room.members).toHaveLength(1);
  } finally {
    client.close();
    await t.server.stop(true);
  }
});

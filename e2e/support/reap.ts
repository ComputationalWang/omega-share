// `bun run e2e:reap` (OME-821): stops this agent's leftover e2e servers, found by owner file, never by process pattern.
// Other agents' entries are listed and left alone.
import { agentIdentity, agentName } from "./ports";
import { OWNER_DIR, describeOwner, groupAlive, launcherAlive, listOwners, ownerAlive, reapTargets, removeOwner, type Owner } from "./owner";

/** Only what still checks out as ours: a recycled pid or group id is never signalled. */
const signal = (o: Owner, s: NodeJS.Signals): void => {
  const targets = [groupAlive(o) ? -o.pgid : null, launcherAlive(o) ? o.pid : null];
  for (const target of targets) {
    if (target === null) continue;
    try {
      process.kill(target, s);
    } catch {
      // already gone
    }
  }
};

const agent = agentIdentity();
const all = listOwners();
const mine = reapTargets(all, agent);
for (const o of mine) {
  if (ownerAlive(o)) signal(o, "SIGTERM");
}
const deadline = Date.now() + 5_000;
while (mine.some(ownerAlive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
for (const o of mine) {
  const was = ownerAlive(o);
  if (was) signal(o, "SIGKILL");
  removeOwner(o.port, OWNER_DIR, o.pid);
  console.log(`reaped :${String(o.port)} (${describeOwner(o)})${was ? " — needed SIGKILL" : ""}`);
}
for (const o of all.filter((x) => !mine.includes(x))) console.log(`left :${String(o.port)} alone — ${ownerAlive(o) ? "running" : "stale"}, ${describeOwner(o)}`);
if (mine.length === 0) console.log(`nothing to reap for ${agentName(agent)} in ${OWNER_DIR}`);

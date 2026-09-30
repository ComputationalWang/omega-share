// `bun e2e/support/headed.ts <command> [args…]`: run a command that starts headed Chromium on a virtual display (OME-210).
// `bun run e2e:real` goes through this; use it for ad-hoc headed scripts too. See docs/qa/headed-on-xvfb.md.
import { planHeadedRun } from "./xvfb";

const plan = planHeadedRun(process.argv.slice(2), process.env, Bun.which("xvfb-run"));
if (plan.notice !== null) console.error(plan.notice);
const child = Bun.spawn([...plan.argv], { env: plan.env, stdio: ["inherit", "inherit", "inherit"] });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => {
  child.kill(sig);
});
process.exit(await child.exited);

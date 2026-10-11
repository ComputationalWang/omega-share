// Is anything listening on a port (OME-821)? Checked on both loopback families: Vite binds `localhost`, which may be ::1.
// `bun e2e/support/probe.ts <port>…` prints a JSON array of booleans, for playwright.config.ts (which must decide synchronously).
import { connect } from "node:net";

function answers(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ port, host });
    const done = (up: boolean): void => {
      s.destroy();
      resolve(up);
    };
    s.setTimeout(1_000, () => {
      done(false);
    });
    s.once("connect", () => {
      done(true);
    });
    s.once("error", () => {
      done(false);
    });
  });
}

export async function portInUse(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([answers(port, "127.0.0.1"), answers(port, "::1")]);
  return v4 || v6;
}

if (import.meta.main) {
  const ports = process.argv.slice(2).map(Number);
  console.log(JSON.stringify(await Promise.all(ports.map(portInUse))));
}

/** What `start()` returns as `server` in black-box mode. */
import { NotBlackBox } from "./env";

export interface Handle {
  port: number;
  stop: () => Promise<void>;
}

/** The in-process server's members a black-box test cannot honour: touching one is NotBlackBox. */
const IN_PROCESS_ONLY = new Set([
  "registry",
  "drain",
  "metricsText",
  "reports",
  "publish",
  "pendingWebSockets",
  "pendingRequests",
  "subscriberCount",
  "reload",
  "upgrade",
  "fetch",
  "timeout",
  "requestIP",
  "url",
  "hostname",
]);

/** Everything else (`then`, `toJSON`, symbols, inspect probes) reads as absent so `await`, `JSON` and `expect` just work. */
export function blackBoxServer(port: number, stop: () => Promise<void>): Handle {
  const members: Record<string, unknown> = { port, stop };
  return new Proxy<Handle>(
    { port, stop },
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        if (IN_PROCESS_ONLY.has(prop)) throw new NotBlackBox(`server.${prop} is not available against the binary`);
        return members[prop];
      },
    },
  );
}

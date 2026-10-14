/** What `start()` returns as `server` in black-box mode. */
import { NotBlackBox } from "./env";

export interface Handle {
  port: number;
  stop: () => Promise<void>;
}

export function blackBoxServer(_port: number, _stop: () => Promise<void>): Handle {
  throw new NotBlackBox("stub");
}

import { RoomIdSchema, ShareRequestSchema, ShareResponseSchema, type Embed } from "@omega/shared";
import * as v from "valibot";

export type ShareResult = { readonly ok: true; readonly embed: Embed } | { readonly ok: false; readonly message: string };

export interface ShareOptions {
  readonly baseUrl: string;
  readonly roomId: string;
  readonly url: string;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
}

/** `POST {baseUrl}/rooms/:id/share`. Request and response are parsed against the contract; never throws. */
export async function shareEmbed({ baseUrl, roomId, url, fetch }: ShareOptions): Promise<ShareResult> {
  const room = v.safeParse(RoomIdSchema, roomId);
  const body = v.safeParse(ShareRequestSchema, { url });
  if (!room.success) return { ok: false, message: "Invalid room." };
  if (!body.success) return { ok: false, message: "That video URL can't be shared." };

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/rooms/${room.output}/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body.output),
    });
  } catch {
    return { ok: false, message: "Could not reach the server." };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  const parsed = v.safeParse(ShareResponseSchema, json);
  if (!parsed.success) return { ok: false, message: "Unexpected response from the server." };
  return parsed.output.ok ? { ok: true, embed: parsed.output.embed } : { ok: false, message: parsed.output.error.message };
}

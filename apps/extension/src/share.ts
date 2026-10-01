import { RoomIdSchema, ShareRequestSchema, ShareResponseSchema, ShareTokenSchema, type AnyEmbed } from "@omega/shared";
import * as v from "valibot";
import { STATUS_TEXT } from "./server-status";
import { SERVER_REQUEST_HEADERS, SERVER_REQUEST_INIT } from "./settings";

export type ShareResult = { readonly ok: true; readonly embed: AnyEmbed } | { readonly ok: false; readonly message: string };

export interface ShareOptions {
  readonly baseUrl: string;
  readonly roomId: string;
  readonly url: string;
  /** The room tab's share token (ADR 0015), or `null` when no room tab was found. */
  readonly token: string | null;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
}

/** `POST {baseUrl}/rooms/:id/share` with `Authorization: Bearer`. Request and response are parsed against the contract; never throws. */
export async function shareEmbed({ baseUrl, roomId, url, token, fetch }: ShareOptions): Promise<ShareResult> {
  if (token === null) return { ok: false, message: STATUS_TEXT.noToken };
  const bearer = v.safeParse(ShareTokenSchema, token);
  const room = v.safeParse(RoomIdSchema, roomId);
  const body = v.safeParse(ShareRequestSchema, { url });
  if (!bearer.success) return { ok: false, message: STATUS_TEXT.tokenRejected };
  if (!room.success) return { ok: false, message: "Invalid room." };
  if (!body.success) return { ok: false, message: "That video URL can't be shared." };

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/rooms/${room.output}/share`, {
      method: "POST",
      headers: { ...SERVER_REQUEST_HEADERS, "content-type": "application/json", authorization: `Bearer ${bearer.output}` },
      body: JSON.stringify(body.output),
      ...SERVER_REQUEST_INIT,
    });
  } catch {
    return { ok: false, message: STATUS_TEXT.unreachable(baseUrl) };
  }
  if (response.type === "opaqueredirect") return { ok: false, message: STATUS_TEXT.signIn };

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  const parsed = v.safeParse(ShareResponseSchema, json);
  // A 401 that isn't ours comes from an edge gate in front of the server.
  if (!parsed.success) return { ok: false, message: response.status === 401 ? STATUS_TEXT.signIn : STATUS_TEXT.offline(baseUrl) };
  if (parsed.output.ok) return { ok: true, embed: parsed.output.embed };
  return { ok: false, message: parsed.output.error.code === "unauthorized" ? STATUS_TEXT.tokenRejected : parsed.output.error.message };
}

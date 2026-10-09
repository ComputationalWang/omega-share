import { RoomIdSchema, ShareRequestSchema, ShareResponseSchema, ShareTokenSchema, type AnyEmbed, type ShareErrorCode } from "@omega/shared";
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

/** What came back from a room POST: the JSON body (`undefined` if it wasn't JSON) and the status, or a message to show. */
export type RoomPostReply = { readonly ok: true; readonly json: unknown; readonly status: number } | { readonly ok: false; readonly message: string };

/**
 * `POST {baseUrl}/rooms/:id/{share|queue}` with `Authorization: Bearer` and a `ShareRequest` body
 * (ADR 0015, 0031). Token, room and body are parsed first, so nothing invalid is ever sent; never throws.
 */
export async function postToRoom(path: "share" | "queue", { baseUrl, roomId, url, token, fetch }: ShareOptions): Promise<RoomPostReply> {
  if (token === null) return { ok: false, message: STATUS_TEXT.noToken };
  const bearer = v.safeParse(ShareTokenSchema, token);
  const room = v.safeParse(RoomIdSchema, roomId);
  const body = v.safeParse(ShareRequestSchema, { url });
  if (!bearer.success) return { ok: false, message: STATUS_TEXT.tokenRejected };
  if (!room.success) return { ok: false, message: "Invalid room." };
  if (!body.success) return { ok: false, message: "That video URL can't be shared." };

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/rooms/${room.output}/${path}`, {
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
  return { ok: true, json, status: response.status };
}

/** The popup's text for a body that isn't on the contract. A 401 that isn't ours comes from an edge gate in front of the server. */
export function offContractMessage(baseUrl: string, status: number): string {
  return status === 401 ? STATUS_TEXT.signIn : STATUS_TEXT.offline(baseUrl);
}

/** The popup's text for a contract error; codes the user can act on get our own wording, the rest show the server's message. */
export function roomErrorMessage(code: ShareErrorCode, message: string): string {
  switch (code) {
    case "unauthorized":
      return STATUS_TEXT.tokenRejected;
    case "control_owner_only":
      return STATUS_TEXT.ownerOnly;
    case "queue_full":
      return STATUS_TEXT.queueFull;
    case "invalid_body":
    case "unsupported_url":
    case "room_not_found":
    case "rate_limited":
    case "payload_too_large":
      return message;
  }
}

/** `POST {baseUrl}/rooms/:id/share`. Request and response are parsed against the contract; never throws. */
export async function shareEmbed(options: ShareOptions): Promise<ShareResult> {
  const reply = await postToRoom("share", options);
  if (!reply.ok) return reply;
  const parsed = v.safeParse(ShareResponseSchema, reply.json);
  if (!parsed.success) return { ok: false, message: offContractMessage(options.baseUrl, reply.status) };
  if (parsed.output.ok) return { ok: true, embed: parsed.output.embed };
  return { ok: false, message: roomErrorMessage(parsed.output.error.code, parsed.output.error.message) };
}

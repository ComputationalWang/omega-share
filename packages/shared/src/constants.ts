/** Room everyone lands in until M2 adds more rooms. */
export const DEFAULT_ROOM_ID = "lobby";
export const SEAT_COUNT = 8;
export const AVATAR_COUNT = 4;
/** People in one room; matches the load-test budget in docs/perf-budgets.md. */
export const MAX_ROOM_MEMBERS = 25;
export const NICKNAME_MAX_LENGTH = 20;
export const CHAT_MAX_LENGTH = 280;
/** Largest WebSocket frame the server accepts from a client, in UTF-8 bytes. */
export const MAX_CLIENT_MESSAGE_BYTES = 4096;
/** Largest frame a client accepts; must fit a worst-case full-room snapshot (~4.7 KB). */
export const MAX_SERVER_MESSAGE_BYTES = 16384;
/** Cap on human-readable error messages sent over the wire. */
export const ERROR_MESSAGE_MAX_LENGTH = 200;

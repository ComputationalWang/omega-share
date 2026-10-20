// The tab's title per view (OME-1238, WCAG 2.4.2). The room's matches the pop-out room window's, with the chat that came
// in while the tab was hidden counted in front.
export const SITE_TITLE = "omega-share";

export const roomPageTitle = (title: string | null, unread: number, _mention = false): string =>
  `${unread === 0 ? "" : `(${String(unread)}) `}${title ?? "Room"} · ${SITE_TITLE}`;
export const NOT_FOUND_TITLE = `Room not found · ${SITE_TITLE}`;

# ADR 0062: On a two-column screen the open editor takes the chat column

**Status:** accepted (2026-11-06) · Lead · [OME-2283](/OME/issues/OME-2283) (judge round 10 on [OME-2061](/OME/issues/OME-2061))

**Context:** From 1200 px wide the open editor was a 312 px column of its own between the room and the chat (OME-1801). At 1280×800 that left the room 576×320, 18 % of the screen, with its people about 15 px tall. The judge asked for at least 25 %. Short screens (a phone held sideways) already made the chat column the editor's sheet (OME-1927).

## Decision

1. **Every two-column screen does what short ones do.** While the editor is open, the chat column shows only Done, the editor and the playback setting (which ends the sheet). Up next, the invite and the chat are hidden until Done. The room's column keeps its full width.
2. **The TV gives way while editing.** `wideLayout(…, editing)` shrinks the TV, never below its floor (ADR 0012), so the stage holds the whole room at the column's width. Without this, a 1440×900 room came out smaller than a 1280×800 one.
3. **On tall screens, nothing in the editor scrolls down to Save as my layout.** The tray is one row of pieces (it scrolls). The room's own name, Rename and Delete room, and then the playback setting, are reached by scrolling the column.

## Consequences

- At 1280×800 the room is 888×493 while editing, 43 % of the screen (it was 18 %). At 1440×900 and up it is 960×532.
- Chat lines that arrive while editing are read after Done. That is accepted: editing is a short, owner-only task, and short screens have worked this way since OME-1927.
- Between 1024 and 1199 px wide the editor used to sit under the room. It is the sheet there too.

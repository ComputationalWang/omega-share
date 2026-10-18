// The owner's tools in the room (split out of room.ts, OME-1100): the "Edit room" key and its editor (set (h)), and the
// moderation tools (ADR 0030). Each loads its own lazy chunk, and only on an owner's page.
import type { ClientMessage, MemberId, OwnerToken, RoomId, RoomLayout } from "@omega/shared";
import type { ChatLogEntry } from "./chat/log";
import { el } from "./controls/dom";
import type { Editor, EditorContext } from "./editor/editor";
import { layoutOf } from "./furniture";
import { STAGE_W, TAG_OFFSET_Y, type Point } from "./layout";
import type { Moderation } from "./owner/moderation";
import { screen, type ViewState } from "./state";

export interface OwnerToolsOptions {
  /** From `omega.rooms`: without it this browser doesn't own the room, and nothing here is made. */
  readonly ownerToken: OwnerToken | undefined;
  readonly roomId: RoomId;
  readonly serverUrl: string;
  /** The scaled stage, its name-tag layer and its view (stage.ts). */
  readonly stage: HTMLElement;
  readonly tags: HTMLElement;
  /** Where the member menu mounts: page chrome over the stage, not clipped by it (owner/moderation.ts). */
  readonly layer: HTMLElement;
  readonly view: EditorContext["view"];
  /** Where a member is drawn now (stage.ts `anchor`). */
  readonly anchor: (id: MemberId) => Point | undefined;
  /** Walk over (OME-1376, room.ts): the walk to that member, or null when no cell beside them is free. */
  readonly walkOver: (id: MemberId) => (() => void) | null;
  readonly follow: (id: MemberId) => void;
  /** Where the Edit room key and the playback setting go. */
  readonly bar: HTMLElement;
  readonly panel: HTMLElement;
  readonly state: () => ViewState;
  readonly send: (m: ClientMessage) => boolean;
  readonly requestRender: () => void;
  /** The phone layout: no editor there (set k). */
  readonly phone: () => boolean;
  /** The room is in its own window: the editor draws on the stage, which is over there. */
  readonly roomOut: () => boolean;
  /** A line in the chat log. */
  readonly log: (entry: ChatLogEntry) => void;
}

export interface OwnerTools {
  /** Each render: the key and the open editor follow the state. */
  readonly render: (s: ViewState) => void;
  /** Last in each render: the moderation tools follow the state. */
  readonly moderate: (s: ViewState) => void;
  /** The owner's unsaved draft, shown to them instead of the room's layout while they edit. */
  readonly preview: () => RoomLayout | null;
  readonly closeEditor: () => void;
  /** The editor is open (or loading): it owns the room floor's clicks and keys. */
  readonly editing: () => boolean;
  /** A keydown on the page: true if the moderation tools took it. */
  readonly key: (ev: KeyboardEvent) => boolean;
}

export function createOwnerTools(o: OwnerToolsOptions): OwnerTools {
  let preview: RoomLayout | null = null;
  let editToggle: HTMLButtonElement | null = null;
  let editor: Editor | null = null;
  /** Bumped on each open/close, so a slow chunk load for an editor that was closed meanwhile is dropped. */
  let editorGen = 0;

  const closeEditor = (): void => {
    editorGen++;
    editor?.destroy();
    editor = null;
    preview = null;
    if (editToggle !== null) {
      editToggle.ariaPressed = "false";
      editToggle.lastChild?.replaceWith("Edit room");
    }
    o.requestRender();
  };

  const openEditor = (toggle: HTMLButtonElement, ownerToken: OwnerToken): void => {
    const gen = ++editorGen;
    toggle.ariaPressed = "true";
    toggle.lastChild?.replaceWith("Done");
    o.requestRender();
    void import("./editor/editor")
      .then(({ mountEditor }) =>
        mountEditor({
          panel: o.panel,
          stage: o.stage,
          view: o.view,
          saved: () => layoutOf(o.state().room),
          title: () => o.state().title,
          preview: (l) => {
            preview = l;
            o.requestRender();
          },
          send: o.send,
          roomId: o.roomId,
          serverUrl: o.serverUrl,
          ownerToken,
          fetch: (url, init) => fetch(url, init),
          alive: () => gen === editorGen,
        }),
      )
      .then((e) => {
        if (gen !== editorGen) e.destroy();
        else editor = e;
      })
      .catch((e: unknown) => {
        console.warn("editor failed to load", e);
        if (gen === editorGen) closeEditor();
      });
  };

  let moderation: Moderation | null = null;
  /** Bumped when the tools go, so a chunk that loads after that is dropped. */
  let moderationGen = 0;
  /** The chunk failed to load: don't retry on every render (a reload tries again). */
  let moderationFailed = false;
  /** The owner's moderation tools (ADR 0030): their own lazy chunk, loaded only on an owner's page. */
  const renderModeration = (s: ViewState): void => {
    const want = s.owner && o.ownerToken !== undefined && screen(s).stage;
    if (!want) {
      if (moderationGen % 2 === 1) {
        moderationGen++;
        moderation?.destroy();
        moderation = null;
      }
      return;
    }
    if (moderation !== null) {
      moderation.update();
      return;
    }
    if (moderationGen % 2 === 1 || moderationFailed) return;
    const gen = ++moderationGen;
    void import("./owner/moderation")
      .then(({ mountModeration }) => {
        if (gen !== moderationGen) return;
        moderation = mountModeration({ stage: o.stage, layer: o.layer, tags: o.tags, bar: o.bar, view: o.state, send: o.send, stageWidth: STAGE_W, walkOver: o.walkOver, follow: o.follow, anchor: (id) => {
          const p = o.anchor(id);
          return p === undefined ? undefined : { x: p.x, y: p.y + TAG_OFFSET_Y };
        } });
        moderation.update();
      })
      .catch((e: unknown) => {
        console.warn("moderation tools failed to load", e);
        moderationFailed = true;
        if (gen === moderationGen) moderationGen++;
      });
  };

  /** Said once per page, the first time an owner is in their open room on a phone. */
  let arrangeHinted = false;
  /** Only the owner, in an open room, gets the key; it isn't in the DOM for anyone else. Never on a phone (set k). */
  const renderEditToggle = (s: ViewState): void => {
    const ownerToken = o.ownerToken;
    const owns = s.owner && ownerToken !== undefined && screen(s).stage;
    if (owns && o.phone() && !arrangeHinted && s.status === "open") {
      arrangeHinted = true;
      o.log({ kind: "system", line: { glyph: "host", actor: null, verb: "Arrange the room on a computer.", time: null, self: true } });
    }
    const want = owns && !o.phone() && !o.roomOut();
    if (!want) {
      if (editToggle !== null) {
        closeEditor();
        editToggle.remove();
        editToggle = null;
      }
      return;
    }
    if (editToggle !== null) {
      editToggle.disabled = s.status !== "open";
      return;
    }
    const b = el("button", { type: "button", className: "ui-button self" }, "edit-room");
    b.ariaPressed = "false";
    b.append(el("span", { className: "ui-sprite ui-icon-arrange", ariaHidden: "true" }), "Edit room");
    b.addEventListener("click", () => {
      if (editor !== null || b.ariaPressed === "true") closeEditor();
      else openEditor(b, ownerToken);
    });
    o.bar.append(b);
    editToggle = b;
  };

  return {
    render: (s) => {
      renderEditToggle(s);
      editor?.update();
    },
    moderate: renderModeration,
    preview: () => preview,
    closeEditor,
    editing: () => editToggle?.ariaPressed === "true",
    key: (ev) => {
      if (moderation?.key(ev) === true) return true;
      // Escape in the open editor works like Done, then focus is back on the key (K5).
      const t = editToggle;
      if (ev.key !== "Escape" || t?.ariaPressed !== "true" || !(ev.target instanceof Node) || !(o.panel.contains(ev.target) || o.stage.contains(ev.target) || ev.target === t)) return false;
      closeEditor();
      t.focus();
      return true;
    },
  };
}

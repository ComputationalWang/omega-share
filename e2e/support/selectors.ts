// The test-id contract between the apps and the e2e suite. App engineers: add these `data-testid`s; change them here, not in specs.
const id = (name: string): string => `[data-testid="${name}"]`;

export const popup = {
  embedItem: id("embed-item"),
  embedsEmpty: id("embeds-empty"),
  shareButton: id("share-button"),
  shareStatus: id("share-status"),
  roomSelect: id("room-select"),
} as const;

export const site = {
  nicknameInput: id("nickname-input"),
  avatarOption: id("avatar-option"),
  joinButton: id("join-button"),
  room: id("room"),
  seat: id("seat"),
  chatInput: id("chat-input"),
  chatMessage: id("chat-message"),
  sharedVideo: id("shared-video"),
  nicknameTag: id("nickname-tag"),
  roomFull: id("room-full"),
  // OME-272: the AGPL-3.0 §13 source offer in the site footer.
  sourceLink: id("source-link"),
  // Created rooms (OME-409, ADR 0028): the home page's create form and lists, the room's invite link, the 4004 state.
  createRoomForm: id("create-room-form"),
  createRoomTitle: id("create-room-title"),
  createRoomPrivate: id("create-room-private"),
  createRoomSubmit: id("create-room-submit"),
  createRoomError: id("create-room-error"),
  publicRoomLink: id("public-room-link"),
  yourRoom: id("your-room"),
  yourRoomLink: id("your-room-link"),
  inviteLink: id("invite-link"),
  inviteCopy: id("invite-copy"),
  roomClosed: id("room-closed"),
  // M3 safety states (OME-189): a refused join (`data-code` is the refusal) and the connection line.
  roomRefused: id("room-refused"),
  roomRefusedAction: id("room-refused-action"),
  connectionStatus: id("connection-status"),
  chatSend: id("chat-send"),
  roomNotice: id("room-notice"),
  // Set (e) playback chrome (OME-89).
  playToggle: id("play-toggle"),
  seek: id("seek"),
  timeCurrent: id("time-current"),
  timeDuration: id("time-duration"),
  muteToggle: id("mute-toggle"),
  volume: id("volume"),
  unmuteButton: id("unmute-button"),
  systemLine: id("system-line"),
  catchingNotice: id("catching-notice"),
  syncNotice: id("sync-notice"),
  // OME-244: the one-line provider hint under the TV (Twitch mature gate).
  tvHint: id("tv-hint"),
  // Owner layout editor (OME-410): the toggle and title are in the room chunk, the rest is the lazy editor chunk.
  roomTitle: id("room-title"),
  editRoom: id("edit-room"),
  editorTray: id("editor-tray"),
  editorTab: id("editor-tab"),
  editorSlot: id("editor-slot"),
  editorHit: id("editor-hit"),
  editorRotate: id("editor-rotate"),
  editorRemove: id("editor-remove"),
  editorSave: id("editor-save"),
  editorProblems: id("editor-problems"),
  editorTitle: id("editor-title"),
  editorRename: id("editor-rename"),
  editorDelete: id("editor-delete"),
  editorDeleteConfirm: id("editor-delete-confirm"),
} as const;

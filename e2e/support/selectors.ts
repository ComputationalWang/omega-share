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
  roomNotice: id("room-notice"),
} as const;

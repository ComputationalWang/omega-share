import { expect, test } from "bun:test";
import { takedownBridge, type BridgeBrowser, type BridgeClose, type BridgeSocket } from "./takedown-bridge";

class Browser implements BridgeBrowser {
  message: ((message: string | Buffer) => void) | null = null;
  closed: (() => void) | null = null;
  readonly received: string[] = [];
  readonly closes: BridgeClose[] = [];
  send(message: string): void { this.received.push(message); }
  close(options: BridgeClose): Promise<void> { this.closes.push(options); return Promise.resolve(); }
  onMessage(callback: (message: string | Buffer) => void): void { this.message = callback; }
  onClose(callback: () => void): void { this.closed = callback; }
}

class Upstream implements BridgeSocket {
  closed: BridgeClose | null = null;
  onText: ((text: string) => void) | null = null;
  onClose: ((closed: BridgeClose) => void) | null = null;
  readonly sent: string[] = [];
  destroyed = false;
  sendText(text: string): void { this.sent.push(text); }
  destroy(): void { this.destroyed = true; }
}

function delayed() {
  const upstream = new Upstream();
  let resolve: (socket: Upstream) => void = () => { throw new Error("promise not initialized"); };
  const promise = new Promise<Upstream>((accept) => { resolve = accept; });
  return { upstream, promise, resolve };
}

test("browser join arriving while upgrade is pending reaches the sole upstream once, in order", async () => {
  const browser = new Browser();
  const connection = delayed();
  const sockets: Upstream[] = [];
  const ready = takedownBridge(browser, () => connection.promise, sockets);
  const join = JSON.stringify({ type: "join", nickname: "guest", avatar: 0 });
  browser.message?.(join);
  browser.message?.("second");
  expect(connection.upstream.sent).toEqual([]);
  connection.resolve(connection.upstream);
  await ready;
  expect(connection.upstream.sent).toEqual([join, "second"]);
  browser.message?.("third");
  expect(connection.upstream.sent).toEqual([join, "second", "third"]);
  expect(sockets).toEqual([connection.upstream]);
  connection.upstream.onText?.("snapshot");
  expect(browser.received).toEqual(["snapshot"]);
  const takenDown = { code: 4006, reason: "taken down" };
  connection.upstream.onClose?.(takenDown);
  expect(browser.closes).toEqual([takenDown]);
});

test("browser close before upgrade settles destroys the upstream without sending stale join", async () => {
  const browser = new Browser();
  const connection = delayed();
  const sockets: Upstream[] = [];
  const ready = takedownBridge(browser, () => connection.promise, sockets);
  browser.message?.("join");
  browser.closed?.();
  connection.resolve(connection.upstream);
  await ready;
  expect(connection.upstream.destroyed).toBe(true);
  expect(connection.upstream.sent).toEqual([]);
});

test("failed upgrade closes the browser once and does not reconnect", async () => {
  const browser = new Browser();
  const sockets: Upstream[] = [];
  let attempts = 0;
  await takedownBridge(browser, () => {
    attempts++;
    return Promise.reject(new Error("upgrade refused"));
  }, sockets);
  expect(browser.closes).toEqual([{ code: 1011, reason: "test bridge upstream connection failed" }]);
  expect(attempts).toBe(1);
  expect(sockets).toEqual([]);
});

test("takedown stays terminal: late traffic is not forwarded and browser close destroys upstream", async () => {
  const browser = new Browser();
  const upstream = new Upstream();
  await takedownBridge(browser, () => Promise.resolve(upstream), []);
  upstream.onClose?.({ code: 4006, reason: "taken down" });
  browser.message?.("late message");
  upstream.onText?.("late snapshot");
  upstream.onClose?.({ code: 1006, reason: "" });
  browser.closed?.();
  expect(browser.closes).toEqual([{ code: 4006, reason: "taken down" }]);
  expect(upstream.sent).toEqual([]);
  expect(browser.received).toEqual([]);
  expect(upstream.destroyed).toBe(true);
});

test("upstream close already received with upgrade is forwarded without a join", async () => {
  const browser = new Browser();
  const connection = delayed();
  const ready = takedownBridge(browser, () => connection.promise, []);
  browser.message?.("join");
  connection.upstream.closed = { code: 4006, reason: "taken down" };
  connection.resolve(connection.upstream);
  await ready;
  expect(browser.closes).toEqual([connection.upstream.closed]);
  expect(connection.upstream.sent).toEqual([]);
});

test("browser disposed during failed upgrade does not create an unhandled close rejection", async () => {
  const browser = new Browser();
  browser.close = () => Promise.reject(new Error("route disposed"));
  await takedownBridge(browser, () => Promise.reject(new Error("upgrade refused")), []);
});

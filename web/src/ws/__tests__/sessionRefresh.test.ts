import { afterEach, expect, it, vi } from "vitest";
import { socket } from "../socket";

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  onclose: (() => void) | null = null;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  close = vi.fn();
  constructor(public url: string) { FakeSocket.instances.push(this); }
}
afterEach(() => { socket.disconnect(); FakeSocket.instances = []; vi.useRealTimers(); vi.unstubAllGlobals(); });

it("replaces the old socket and cancels pending reconnects when a password change refreshes the token", () => {
  vi.useFakeTimers(); vi.stubGlobal("WebSocket", FakeSocket);
  socket.connect("old-token");
  const old = FakeSocket.instances[0];
  old.onclose!(); // The server closes old sessions before returning the fresh JWT.
  socket.connect("fresh-token");
  expect(old.close).toHaveBeenCalled();
  old.onclose!(); // A late close callback must not resurrect the old session.
  vi.advanceTimersByTime(6000);
  expect(FakeSocket.instances).toHaveLength(2);
  expect(FakeSocket.instances[1].url).toContain("token=fresh-token");
});

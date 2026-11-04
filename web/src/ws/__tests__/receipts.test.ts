import { describe, expect, it, vi } from "vitest";
import { socket } from "../socket";
import {
  applyLocalStatus,
  applyReadAck,
  sendMessageStatus,
  pickAckIds,
  statusRank,
} from "../receipts";
import type { Message } from "../../api/types";

function msg(partial: Partial<Message> & Pick<Message, "id" | "sender_id" | "status">): Message {
  return {
    chat_id: "c1",
    payload: "hi",
    created_at: new Date().toISOString(),
    ...partial,
  };
}

describe("receipts", () => {
  it("picks only incoming messages below target status", () => {
    const list = [
      msg({ id: "1", sender_id: "peer", status: "sent" }),
      msg({ id: "2", sender_id: "me", status: "sent" }),
      msg({ id: "3", sender_id: "peer", status: "delivered" }),
      msg({ id: "4", sender_id: "peer", status: "read" }),
    ];
    expect(pickAckIds(list, "me", "delivered")).toEqual(["1"]);
    expect(pickAckIds(list, "me", "read")).toEqual(["1", "3"]);
  });

  it("applies local status without downgrade", () => {
    const messages = {
      c1: [
        msg({ id: "1", sender_id: "peer", status: "delivered" }),
        msg({ id: "2", sender_id: "peer", status: "sent" }),
      ],
    };
    const next = applyLocalStatus(messages, ["1", "2"], "read");
    expect(next.c1[0].status).toBe("read");
    expect(next.c1[1].status).toBe("read");

    const same = applyLocalStatus(next, ["1"], "delivered");
    expect(same).toBe(next);
  });

  it("ranks statuses", () => {
    expect(statusRank("sent")).toBeLessThan(statusRank("delivered"));
    expect(statusRank("delivered")).toBeLessThan(statusRank("read"));
  });
  it("acknowledges group reads independently of someone else's shared status", () => {
    const messages = [msg({ id: "1", sender_id: "peer", status: "read" }),
      msg({ id: "2", sender_id: "peer", status: "read", read_by_me: true }),
      msg({ id: "3", sender_id: "me", status: "sent" })];
    expect(pickAckIds(messages, "me", "read", true)).toEqual(["1"]);
    expect(pickAckIds(messages, "me", "read", false)).toEqual([]);
    const state = { c1: messages };
    const read = applyReadAck(state, ["1"]);
    expect(read.c1[0].read_by_me).toBe(true);
    expect(read.c1[0].status).toBe("read");
    expect(pickAckIds(read.c1, "me", "read", true)).toEqual([]);
    expect(applyReadAck(read, ["1"])).toBe(read);
  });
  it("sends every receipt when loaded history is larger than the server batch limit", () => {
    const send = vi.spyOn(socket, "send").mockImplementation(() => {});
    const ids = Array.from({ length: 1000 }, (_, index) => `message-${index}`);
    sendMessageStatus(ids, "read");
    const batches = send.mock.calls.map(([event]) => event as { message_ids: string[]; status: string });
    expect(batches.flatMap(event => event.message_ids)).toEqual(ids);
    expect(batches.every(event => event.message_ids.length <= 512 && event.status === "read")).toBe(true);
    send.mockRestore();
  });
});

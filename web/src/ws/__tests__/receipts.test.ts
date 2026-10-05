import { describe, expect, it } from "vitest";
import {
  applyLocalStatus,
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
});

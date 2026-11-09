import { beforeEach, expect, it, vi } from "vitest";

const memory = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) });
const { useUiStore } = await import("../../store/ui");
const { showOpenedChat } = await import("../showOpenedChat");

beforeEach(() => useUiStore.setState({ tab: "contacts", mobileChatOpen: false }));

it("shows the chat once it has opened", async () => {
  await showOpenedChat(async () => {});
  expect(useUiStore.getState()).toMatchObject({ tab: "chats", mobileChatOpen: true });
});

it("does not pull the person back after they switched tabs during a slow open", async () => {
  let finish!: () => void;
  const opening = showOpenedChat(() => new Promise<void>((resolve) => { finish = resolve; }));
  useUiStore.getState().setTab("stars");
  finish();
  await opening;
  expect(useUiStore.getState()).toMatchObject({ tab: "stars", mobileChatOpen: false });
});

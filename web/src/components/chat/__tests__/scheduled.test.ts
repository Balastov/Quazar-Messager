import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WhenDialog from "../WhenDialog";
import ScheduleButton from "../ScheduleButton";
import { ScheduledList } from "../ScheduledBar";

vi.mock("../../../store/chat", () => ({ useChatStore: vi.fn() }));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((x) => x.textContent?.includes(text));
  if (!found) throw new Error(`Button not found: ${text}`);
  return found;
}

describe("scheduled messages UI", () => {
  it("has an accessible clock button that never submits the composer", async () => {
    const open = vi.fn();
    await act(async () => root.render(createElement(ScheduleButton, { onClick: open })));
    const clock = host.querySelector("button")!;
    expect(clock.type).toBe("button");
    expect(clock.getAttribute("aria-label")).toBe("Отправить позже");
    await act(async () => clock.click());
    expect(open).toHaveBeenCalledOnce();
  });

  it("chooses a preset, blocks repeat submissions while saving, and closes after success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T10:00:00Z"));
    let finish!: () => void;
    const pick = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const close = vi.fn();
    await act(async () => root.render(createElement(WhenDialog, {
      title: "Отправить позже", onPick: pick, onClose: close,
    })));
    await act(async () => button("Через 1 час").click());
    expect(pick).toHaveBeenCalledWith(new Date("2026-10-30T11:00:00Z"));
    expect(button("Через 1 час").disabled).toBe(true);
    expect((document.querySelector('input[type="datetime-local"]') as HTMLInputElement).disabled).toBe(true);
    await act(async () => button("Через 1 час").click());
    expect(pick).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps the time dialog open and allows retry when scheduling fails", async () => {
    const pick = vi.fn().mockRejectedValue(new Error("Нет соединения"));
    const close = vi.fn();
    await act(async () => root.render(createElement(WhenDialog, {
      title: "Отправить позже", onPick: pick, onClose: close,
    })));
    await act(async () => button("Через 1 час").click());
    expect(document.body.textContent).toContain("Нет соединения");
    expect(close).not.toHaveBeenCalled();
    expect(button("Готово").disabled).toBe(false);
  });

  it("lists delivery time and text, and reports a failed cancellation", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("offline"));
    await act(async () => root.render(createElement(ScheduledList, {
      items: [{ id: "later-1", text: "Не забудь встречу", sendAt: "2026-12-01T12:00:00Z" }],
      onCancel: cancel,
    })));
    expect(host.textContent).toContain("Отложенные: 1");
    expect(host.textContent).not.toContain("Не забудь встречу");
    await act(async () => button("Отложенные").click());
    expect(host.textContent).toContain("Не забудь встречу");
    const remove = host.querySelector('[aria-label="Не отправлять"]') as HTMLButtonElement;
    await act(async () => remove.click());
    expect(cancel).toHaveBeenCalledWith("later-1");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Не удалось отменить отправку");
    expect(remove.disabled).toBe(false);
  });
});

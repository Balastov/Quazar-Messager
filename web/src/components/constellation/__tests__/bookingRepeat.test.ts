import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { AxiosError, AxiosHeaders } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StarBooking, StarChannel, StarDetail } from "../../../api/stars";

const memory = new Map<string, string>();
vi.stubGlobal("localStorage", { getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, value: string) => void memory.set(k, value), removeItem: (k: string) => void memory.delete(k) });
vi.mock("../../../ws/socket", () => ({ socket: { on: () => () => {}, onStatus: () => () => {}, send: vi.fn(), isOpen: () => true } }));

const { describeRepeat, presetRule, repeatPresets } = await import("../repeat");
const { useStarsStore } = await import("../../../store/stars");
const { useAuthStore } = await import("../../../store/auth");
const { BookingDialog, CancelSeriesDialog } = await import("../WorkRoom");

describe("describeRepeat — как на сервере", () => {
  // Те же случаи, что в backend/tests/test_booking_series.py → test_describe_in_russian.
  const cases: [Parameters<typeof describeRepeat>[0], string, string][] = [
    [{ freq: "daily", interval: 1 }, "2026-12-01", "каждый день"],
    [{ freq: "daily", interval: 3 }, "2026-12-01", "раз в 3 дня"],
    [{ freq: "weekly", interval: 1, weekdays: [0, 1, 2, 3, 4] }, "2026-12-01", "по будням"],
    [{ freq: "weekly", interval: 1, weekdays: [1, 3] }, "2026-12-01", "по вторникам и четвергам"],
    [{ freq: "weekly", interval: 2, weekdays: [2] }, "2026-12-02", "раз в 2 недели, по средам"],
    [{ freq: "monthly", interval: 1, monthly: "day" }, "2026-12-15", "каждый месяц, 15-го числа"],
    [{ freq: "monthly", interval: 1, monthly: "weekday" }, "2026-12-08", "каждый месяц, во второй вторник"],
    [{ freq: "monthly", interval: 1, monthly: "weekday" }, "2026-12-16", "каждый месяц, в третью среду"],
    [{ freq: "monthly", interval: 1, monthly: "last_weekday" }, "2026-12-25", "каждый месяц, в последнюю пятницу"],
    [{ freq: "daily", interval: 1, count: 5 }, "2026-12-01", "каждый день, 5 раз"],
    [{ freq: "daily", interval: 1, until: "2026-12-31" }, "2026-12-01", "каждый день, до 31.12.2026"],
  ];
  it.each(cases)("%j", (rule, day, text) => {
    expect(describeRepeat(rule, new Date(`${day}T10:00`))).toBe(text);
  });
});

describe("repeatPresets", () => {
  it("предлагает варианты по выбранному дню", () => {
    // Пт 25.12.2026 — четвёртая и последняя пятница месяца.
    const friday = new Date("2026-12-25T10:00");
    const labels = repeatPresets(friday).map((p) => p.label);
    expect(labels).toContain("Каждую неделю, по пятницам");
    expect(labels).toContain("Каждый месяц, 25-го числа");
    expect(labels).toContain("Каждый месяц, в четвёртую пятницу");
    expect(labels).toContain("Каждый месяц, в последнюю пятницу");
    expect(presetRule("weekly", friday)).toEqual({ freq: "weekly", interval: 1, weekdays: [4] });
    // 29.12 — пятый вторник: «в пятый вторник» не предлагаем, только «в последний».
    const values = repeatPresets(new Date("2026-12-29T10:00")).map((p) => p.value);
    expect(values).not.toContain("monthly_weekday");
    expect(values).toContain("monthly_last");
  });
});

let host: HTMLDivElement;
let root: Root;
const channel = { id: "room", star_id: "star", kind: "planet", name: "Переговорка" } as StarChannel;
const detail = { id: "star", name: "Офис", kind: "work", my_role: "member", channels: [channel], members: [
  { user: { id: "me", username: "me", display_name: "Анна" }, role: "member" },
] } as unknown as StarDetail;

function render(node: ReturnType<typeof createElement>) {
  act(() => root.render(node));
}

function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    select.value = value;
    Simulate.change(select);
  });
}

function button(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`нет кнопки «${text}»`);
  return found as HTMLButtonElement;
}

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  useAuthStore.setState({ user: { id: "me" } as never });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("BookingDialog — повтор", () => {
  it("без повтора отправляет обычную бронь", async () => {
    const book = vi.fn().mockResolvedValue(undefined);
    useStarsStore.setState({ book });
    const onClose = vi.fn();
    render(createElement(BookingDialog, { detail, channel, onClose }));
    act(() => Simulate.submit(host.querySelector("form")!));
    await flush();
    expect(book.mock.calls[0][1].repeat).toBeUndefined();
    expect(onClose).toHaveBeenCalled();
  });

  it("поздно вечером конец по умолчанию — 23:59 того же дня, бронь уходит", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-26T23:10:00"));
    try {
      const book = vi.fn().mockResolvedValue(undefined);
      useStarsStore.setState({ book });
      render(createElement(BookingDialog, { detail, channel, onClose: vi.fn() }));
      act(() => Simulate.submit(host.querySelector("form")!));
      await flush();
      const body = book.mock.calls[0][1];
      expect(new Date(body.starts_at)).toEqual(new Date("2026-11-26T23:30:00"));
      expect(new Date(body.ends_at)).toEqual(new Date("2026-11-26T23:59:00"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("свой повтор: раз в 2 недели по выбранным дням, после 6 встреч", async () => {
    const book = vi.fn().mockResolvedValue(undefined);
    useStarsStore.setState({ book });
    render(createElement(BookingDialog, { detail, channel, onClose: vi.fn() }));
    const day = host.querySelector<HTMLInputElement>('input[type="date"]')!;
    act(() => {
      day.value = "2026-12-01"; // вторник
      Simulate.change(day);
    });
    choose(host.querySelector<HTMLSelectElement>('[data-testid="booking-repeat"]')!, "custom");
    const every = host.querySelector<HTMLInputElement>('[aria-label="Интервал повтора"]')!;
    act(() => {
      every.value = "2";
      Simulate.change(every);
    });
    act(() => Simulate.click(button("Чт")));
    const count = host.querySelector<HTMLInputElement>('[aria-label="Сколько встреч"]')!;
    act(() => {
      Simulate.focus(count);
      count.value = "6";
      Simulate.change(count);
    });
    expect(host.textContent).toContain("Раз в 2 недели, по вторникам и четвергам, 6 раз");
    act(() => Simulate.submit(host.querySelector("form")!));
    await flush();
    const body = book.mock.calls[0][1];
    expect(body.repeat).toEqual({ freq: "weekly", interval: 2, weekdays: [1, 3], until: null, count: 6 });
    expect(body.tz).toBeTruthy();
    expect(body.skip_busy).toBe(false);
  });

  it("занятые дни: показывает их и бронирует остальные", async () => {
    const busy = {
      message: "Комната занята в 1 день из 9 на ближайшие 60 дней",
      busy: [{ starts_at: "2026-12-08T07:00:00+00:00", ends_at: "2026-12-08T08:00:00+00:00", title: "Ретро", who: "Боб" }],
      free: 8,
    };
    const conflict = new AxiosError("409", "ERR_BAD_REQUEST", undefined, undefined, {
      status: 409, statusText: "Conflict", data: { detail: busy }, headers: {}, config: { headers: new AxiosHeaders() },
    });
    const book = vi.fn().mockRejectedValueOnce(conflict).mockResolvedValueOnce(undefined);
    useStarsStore.setState({ book });
    const onClose = vi.fn();
    render(createElement(BookingDialog, { detail, channel, onClose }));
    choose(host.querySelector<HTMLSelectElement>('[data-testid="booking-repeat"]')!, "weekly");
    act(() => Simulate.submit(host.querySelector("form")!));
    await flush();
    expect(host.textContent).toContain("Комната занята в 1 день");
    expect(host.textContent).toContain("«Ретро» (Боб)");
    act(() => Simulate.click(button("Забронировать остальные (8)")));
    await flush();
    expect(book.mock.calls[1][1].skip_busy).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("CancelSeriesDialog", () => {
  it("отменяет выбранную часть серии", async () => {
    const cancelBooking = vi.fn().mockResolvedValue(undefined);
    useStarsStore.setState({ cancelBooking });
    const booking = { id: "b1", channel_id: "room", title: "Планёрка", starts_at: "2026-12-08T07:00:00Z",
      ends_at: "2026-12-08T08:00:00Z", created_by: "me", attendees: [], series_id: "s1",
      repeat: { freq: "weekly", interval: 1, weekdays: [1] } } as StarBooking;
    const onClose = vi.fn();
    render(createElement(CancelSeriesDialog, { booking, onClose }));
    expect(document.body.textContent).toContain("🔁 По вторникам.");
    const following = [...document.body.querySelectorAll("label")].find((l) => l.textContent === "Эту и следующие")!;
    act(() => Simulate.change(following.querySelector("input")!));
    act(() => Simulate.click(button("Отменить")));
    await flush();
    expect(cancelBooking).toHaveBeenCalledWith(booking, "following");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("BookingDialog — изменение брони", () => {
  const detailWithBob = { ...detail, members: [...detail.members,
    { user: { id: "bob", username: "bob", display_name: "Боб" }, role: "member" }] } as unknown as StarDetail;
  const single = { id: "b1", channel_id: "room", title: "Демо", starts_at: "2026-12-01T07:00:00Z",
    ends_at: "2026-12-01T08:30:00Z", created_by: "me", attendees: ["bob"] } as StarBooking;

  it("заполняет поля из брони и сохраняет изменения", async () => {
    const updateBooking = vi.fn().mockResolvedValue(undefined);
    const book = vi.fn();
    useStarsStore.setState({ updateBooking, book });
    const onClose = vi.fn();
    render(createElement(BookingDialog, { detail: detailWithBob, channel, onClose, editing: single }));
    expect(host.textContent).toContain("Изменить бронь: Переговорка");
    expect(host.querySelector<HTMLInputElement>('input[placeholder="Планёрка"]')!.value).toBe("Демо");
    expect(host.querySelector('[data-testid="booking-repeat"]')).toBeNull();
    const bob = [...host.querySelectorAll("label")].find((l) => l.textContent === "Боб")!.querySelector("input")!;
    expect(bob.checked).toBe(true);
    const title = host.querySelector<HTMLInputElement>('input[placeholder="Планёрка"]')!;
    act(() => {
      title.value = "Демо v2";
      Simulate.change(title);
    });
    act(() => Simulate.change(bob, { target: { checked: false } } as never));
    act(() => Simulate.submit(host.querySelector("form")!));
    await flush();
    expect(book).not.toHaveBeenCalled();
    const [booking, body, scope] = updateBooking.mock.calls[0];
    expect(booking).toBe(single);
    expect(body).toEqual({ title: "Демо v2", starts_at: "2026-12-01T07:00:00.000Z", ends_at: "2026-12-01T08:30:00.000Z", attendees: [] });
    expect(scope).toBe("one");
    expect(onClose).toHaveBeenCalled();
  });

  it("у встречи серии: «Эту и следующие» — день не меняется", async () => {
    const updateBooking = vi.fn().mockResolvedValue(undefined);
    useStarsStore.setState({ updateBooking });
    const occurrence = { ...single, series_id: "s1", repeat: { freq: "weekly", interval: 1, weekdays: [1] } } as StarBooking;
    render(createElement(BookingDialog, { detail: detailWithBob, channel, onClose: vi.fn(), editing: occurrence }));
    const day = host.querySelector<HTMLInputElement>('input[type="date"]')!;
    expect(day.disabled).toBe(false);
    expect(host.textContent).toContain("Повтор не меняется");
    const following = [...host.querySelectorAll("label")].find((l) => l.textContent === "Эту и следующие")!;
    act(() => Simulate.change(following.querySelector("input")!));
    expect(day.disabled).toBe(true);
    expect(host.textContent).toContain("Каждая встреча останется в свой день");
    act(() => Simulate.submit(host.querySelector("form")!));
    await flush();
    expect(updateBooking.mock.calls[0][2]).toBe("following");
  });
});

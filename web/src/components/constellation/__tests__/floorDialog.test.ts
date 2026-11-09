import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StarDetail, StarFloor } from "../../../api/stars";

const state = vi.hoisted(() => ({ stars: { createFloor: vi.fn() } }));
vi.mock("../../../store/stars", () => ({ useStarsStore: (selector: (value: typeof state.stars) => unknown) => selector(state.stars) }));
const { starsApi } = await import("../../../api/stars");
const { CreateFloorDialog, FloorAccessDialog } = await import("../FloorDialog");

const member = (id: string, role: string) => ({ user: { id, username: id, display_name: id }, role, joined_at: "", tag_ids: [] });
const detail = {
  id: "star", kind: "work", my_role: "owner", my_permissions: ["edit_map"],
  role_permissions: { moderator: [], member: [] },
  members: [member("boss", "owner"), member("alice", "member"), member("bob", "member"), member("mod", "moderator")],
} as unknown as StarDetail;
const floor = { id: "f2", name: "Бухгалтерия", position: 1, version: 0, access: "none" } as StarFloor;
let host: HTMLDivElement, root: Root;

const button = (text: string) => {
  const node = [...host.querySelectorAll("button")].find((el) => el.textContent?.startsWith(text));
  if (!node) throw new Error(`Missing button: ${text}`);
  return node as HTMLButtonElement;
};
const radio = (value: string) => host.querySelector(`input[type="radio"][value="${value}"]`) as HTMLInputElement;
const box = (name: string) =>
  [...host.querySelectorAll("label")].find((l) => l.textContent === name)!.querySelector("input") as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("does not create a floor until access is chosen", async () => {
  state.stars.createFloor.mockResolvedValue("new");
  const onCreated = vi.fn();
  await act(async () => root.render(createElement(CreateFloorDialog, { defaultName: "2 этаж", onClose: vi.fn(), onCreated })));
  expect(radio("all").checked || radio("none").checked).toBe(false);
  expect(button("Создать этаж").disabled).toBe(true);
  await act(async () => Simulate.change(radio("none")));
  expect(button("Создать этаж").disabled).toBe(false);
  await act(async () => Simulate.submit(host.querySelector("form")!));
  expect(state.stars.createFloor).toHaveBeenCalledWith("2 этаж", "none");
  expect(onCreated).toHaveBeenCalledWith("new");
});

it("edits per-member access and leaves role-based access out of the list", async () => {
  vi.spyOn(starsApi, "floorAccess").mockResolvedValue({ floor_id: "f2", access: "none", user_ids: ["alice"] });
  const save = vi.spyOn(starsApi, "setFloorAccess").mockResolvedValue({ floor_id: "f2", access: "all", user_ids: [] });
  await act(async () => root.render(createElement(FloorAccessDialog, { detail, floor, onClose: vi.fn() })));
  expect(radio("none").checked).toBe(true);
  expect(box("alice").checked).toBe(true);
  expect(box("bob").checked).toBe(false);
  expect(host.textContent).toContain("Всегда видят все этажи: boss.");
  expect(host.textContent).toContain("Гостевые ссылки работают как раньше");

  // «Доступен всем» отмечает всех, затем одного исключаем.
  await act(async () => Simulate.change(radio("all")));
  expect([box("alice").checked, box("bob").checked, box("mod").checked]).toEqual([true, true, true]);
  await act(async () => Simulate.change(box("bob")));
  await act(async () => Simulate.submit(host.querySelector("form")!));
  expect(save).toHaveBeenCalledWith("star", "f2", "all", expect.arrayContaining(["alice", "mod"]));
  expect(save.mock.calls[0][3]).not.toContain("bob");
});

it("lists floors in Star settings, edits access inline and creates a floor there", async () => {
  const { FloorsTab } = await import("../FloorsSettings");
  vi.spyOn(starsApi, "floorAccess").mockResolvedValue({ floor_id: "f1", access: "all", user_ids: ["alice", "bob", "mod"] });
  const floors = [{ id: "f1", name: "1 этаж", position: 0, version: 0, access: "all" }, floor];
  await act(async () => root.render(createElement(FloorsTab, { detail: { ...detail, floors } as StarDetail })));
  expect(button("🔒 Бухгалтерия")).toBeTruthy();
  expect(radio("all").checked).toBe(true);
  expect(box("alice").checked).toBe(true);

  await act(async () => Simulate.click(button("🔒 Бухгалтерия")));
  expect(starsApi.floorAccess).toHaveBeenLastCalledWith("star", "f2");

  await act(async () => Simulate.click(button("+ Этаж")));
  expect((host.querySelector("input:not([type])") as HTMLInputElement).value).toBe("3 этаж");
  expect(button("Создать этаж").disabled).toBe(true);
});

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StarDetail, StarMember } from "../../../api/stars";
import { displayName as accountName, profileInitial } from "../../../utils/profile";
import { StarProfiles, useStarDisplayName } from "../StarProfiles";

const state = vi.hoisted(() => ({ myId: "me", details: {} as Record<string, StarDetail>, save: vi.fn() }));
vi.mock("../../../store/auth", () => ({ useAuthStore: (selector: (value: { user: { id: string } }) => unknown) => selector({ user: { id: state.myId } }) }));
vi.mock("../../../store/stars", () => ({ useStarsStore: (selector: (value: { details: typeof state.details; setMemberPseudonym: typeof state.save }) => unknown) => selector({ details: state.details, setMemberPseudonym: state.save }) }));
const { default: PseudonymDialog, canEditPseudonym } = await import("../PseudonymDialog");

let host: HTMLDivElement, root: Root;
const person = (id: string, role = "member", pseudonym: string | null = "Луна"): StarMember => ({
  role: role as StarMember["role"], joined_at: "2026-11-05T00:00:00Z",
  user: { id, username: id, display_name: "Имя Фамилия", avatar_url: null, pseudonym, pseudonym_star_id: "a", pseudonym_version: 1 },
});
const detail = (id = "a", member = person("me"), myRole = "member") => ({ id, name: "Звезда", my_role: myRole, members: [member] }) as StarDetail;
const renderDialog = (star = detail(), member = star.members[0]) => act(async () => root.render(createElement(PseudonymDialog, { detail: star, member, onClose: vi.fn() })));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.clearAllMocks();
  state.myId = "me"; state.details = {}; state.save.mockResolvedValue(undefined);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("allows self-service for every role and protects other owners and admins", () => {
  for (const role of ["owner", "admin", "moderator", "member"]) {
    expect(canEditPseudonym("me", role, person("me", role))).toBe(true);
    for (const targetRole of ["owner", "admin", "moderator", "member"]) {
      expect(canEditPseudonym("me", role, person("other", targetRole))).toBe(
        ["owner", "admin"].includes(role) && !["owner", "admin"].includes(targetRole));
    }
  }
});

it("saves a new pseudonym in the chosen Star without touching account names", async () => {
  await renderDialog();
  const input = host.querySelector("input")!;
  await act(async () => { input.value = "Сова"; Simulate.change(input); });
  await act(async () => Simulate.submit(host.querySelector("form")!));
  expect(state.save).toHaveBeenCalledWith("a", "me", "Сова");
});

it("clears a pseudonym through an explicit null", async () => {
  await renderDialog();
  const clear = [...host.querySelectorAll("button")].find(button => button.textContent === "Убрать псевдоним")!;
  await act(async () => clear.click());
  expect(state.save).toHaveBeenCalledWith("a", "me", null);
});

it("stops editing when the target becomes an admin while the dialog is open", async () => {
  const member = person("other"), star = detail("a", member, "admin");
  await renderDialog(star, member);
  expect(host.querySelector("input")?.disabled).toBe(false);
  state.details.a = detail("a", person("other", "admin"), "admin");
  await renderDialog(star, member);
  expect(host.querySelector("input")?.disabled).toBe(true);
  await act(async () => Simulate.submit(host.querySelector("form")!));
  expect(state.save).not.toHaveBeenCalled();
});

it("shows censorship errors and keeps the entered pseudonym for correction", async () => {
  state.save.mockRejectedValue(new Error("Псевдоним содержит недопустимое слово"));
  await renderDialog();
  await act(async () => Simulate.submit(host.querySelector("form")!));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("недопустимое слово");
  expect(host.querySelector("input")?.value).toBe("Луна");
});

function CachedAuthor({ user }: { user: StarMember["user"] }) {
  const name = useStarDisplayName();
  return createElement("span", null, name(user));
}

it("renames cached message authors immediately and restores the account name on deletion", async () => {
  const old = person("me").user;
  const show = (member: StarMember) => act(async () => root.render(createElement(StarProfiles, {
    detail: detail("a", member), children: createElement(CachedAuthor, { user: old }),
  })));
  await show(person("me", "member", "Сова"));
  expect(host.textContent).toBe("Сова");
  await show(person("me", "member", null));
  expect(host.textContent).toBe("Имя Фамилия");
  expect(accountName({ username: "me", display_name: "Имя Фамилия" })).toBe("Имя Фамилия");
});

it("does not leak another Star's pseudonym through a cached shared-satellite author", async () => {
  const old = { ...person("outsider").user, display_name: "Луна", account_display_name: "Имя Фамилия" };
  await act(async () => root.render(createElement(StarProfiles, { detail: detail("b"), children: createElement(CachedAuthor, { user: old }) })));
  expect(host.textContent).toBe("Имя Фамилия");
});

it("preserves a whole emoji or flag in avatar initials", () => {
  expect(profileInitial("👨‍👩‍👧‍👦 Семья")).toBe("👨‍👩‍👧‍👦");
  expect(profileInitial("🇨🇳 Китай")).toBe("🇨🇳");
  expect(profileInitial("луна")).toBe("Л");
});

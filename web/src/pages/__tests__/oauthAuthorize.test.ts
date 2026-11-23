import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = new Map<string, string>();
vi.stubGlobal("sessionStorage", {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, String(v)),
  removeItem: (k: string) => void memory.delete(k),
});

const { maskedPhone, readRequest, withParams } = await import("../OAuthAuthorizePage");
const { clearReturn, pathAfterLogin, pendingReturn, rememberReturn } = await import("../../auth/returnAfterLogin");

const CHALLENGE = "a".repeat(43);
const query = (extra: Record<string, string> = {}) => "?" + new URLSearchParams({
  response_type: "code", client_id: "padma", redirect_uri: "https://www.padma.ru/api/auth/quazar/callback",
  state: "st", code_challenge: CHALLENGE, code_challenge_method: "S256", ...extra,
}).toString();

describe("authorize request", () => {
  it("accepts a complete PKCE request", () => {
    expect(readRequest(query())).toEqual({
      client_id: "padma", redirect_uri: "https://www.padma.ru/api/auth/quazar/callback", state: "st",
      code_challenge: CHALLENGE, code_challenge_method: "S256",
    });
  });

  it("rejects requests that are not code + S256 or miss state", () => {
    expect(readRequest(query({ response_type: "token" }))).toBeNull();
    expect(readRequest(query({ code_challenge_method: "plain" }))).toBeNull();
    expect(readRequest(query({ code_challenge: "short" }))).toBeNull();
    expect(readRequest(query({ state: "" }))).toBeNull();
  });

  it("adds error and state to the return address, keeping its own query", () => {
    expect(withParams("https://p.ru/cb", { error: "access_denied", state: "a b" })).toBe("https://p.ru/cb?error=access_denied&state=a+b");
    expect(withParams("https://p.ru/cb?x=1", { state: "s" })).toBe("https://p.ru/cb?x=1&state=s");
  });

  it("shows only the last two digits of the phone", () => {
    expect(maskedPhone("+79991234512")).toBe("+7 ••• •••-••-12");
    expect(maskedPhone(null)).toBe("");
  });
});

describe("return after login", () => {
  beforeEach(() => memory.clear());

  it("remembers only the authorize page", () => {
    rememberReturn("/oauth/authorize" + query(), "Padma");
    expect(pendingReturn()).toEqual({ path: "/oauth/authorize" + query(), name: "Padma" });
    expect(pathAfterLogin()).toBe("/oauth/authorize" + query());
    clearReturn();
    expect(pathAfterLogin()).toBe("/");
  });

  it("ignores other or tampered addresses", () => {
    rememberReturn("/settings", "Padma");
    expect(pendingReturn()).toBeNull();
    memory.set("quazar-return-after-login", JSON.stringify({ path: "https://evil.example/oauth/authorize?x", name: "x" }));
    expect(pathAfterLogin()).toBe("/");
    memory.set("quazar-return-after-login", "{broken");
    expect(pathAfterLogin()).toBe("/");
  });
});

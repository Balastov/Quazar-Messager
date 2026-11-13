import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); window.history.replaceState(null, "", "/"); });

it("exchanges once under StrictMode, strips the fragment and uses no browser credentials", async () => {
  window.history.replaceState(null, "", "/bitrix24.html?DOMAIN=is4business.bitrix24.ru#code=secret-code");
  const result = { portal: "https://is4business.bitrix24.ru", employee_id: "27", display_name: "Иван", mode: "launch" };
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => result });
  vi.stubGlobal("fetch", fetch);
  const { launchContext } = await import("./context");
  const first = launchContext(), second = launchContext();
  expect(first).toBe(second); expect(await first).toEqual(result);
  expect(window.location.hash).toBe("");
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "omit", cache: "no-store", body: JSON.stringify({ code: "secret-code" }) });
});

it("rejects direct opening without calling the API", async () => {
  window.history.replaceState(null, "", "/bitrix24.html");
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const { launchContext } = await import("./context");
  await expect(launchContext()).rejects.toThrow("из меню");
  expect(fetch).not.toHaveBeenCalled();
});

it("shows expired launch instead of reusing a code", async () => {
  window.history.replaceState(null, "", "/bitrix24.html#code=expired");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ detail: "Запуск устарел" }) }));
  const { launchContext } = await import("./context");
  await expect(launchContext()).rejects.toThrow("Запуск устарел");
  expect(window.location.hash).toBe("");
});

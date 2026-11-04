import { afterEach, expect, it, vi } from "vitest";
import { desktopFeedVersion, publishedDesktopRelease } from "../desktopReleases";

afterEach(() => vi.unstubAllGlobals());

it("reads only a single stable release version and ignores arbitrary URLs in the feed", async () => {
  expect(desktopFeedVersion("version: 0.20.3\nfiles:\n  - url: Quazar.exe\n")).toBe("0.20.3");
  expect(desktopFeedVersion("version: '0.20.3'\r\n")).toBe("0.20.3");
  for (const text of ["<html>not found</html>", "version: 0.20.3-beta.1\n", "version: 0.20.3\nversion: 9.0.0\n", "version: ../../bad\n", "a".repeat(65_000)]) {
    expect(desktopFeedVersion(text)).toBeNull();
  }
  vi.stubGlobal("fetch", vi.fn(async () => new Response("version: 0.20.3\npath: https://untrusted.test/installer.exe\n")));
  const release = await publishedDesktopRelease("windows", new AbortController().signal);
  expect(release?.installers[0].url).toBe("/desktop-updates/win-x64/Quazar-0.20.3-win-x64.exe");
  expect(fetch).toHaveBeenCalledWith("/desktop-updates/win-x64/latest.yml", expect.objectContaining({ cache: "no-store", credentials: "omit" }));
});

it("waits for both Mac architectures to publish the same version", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(`version: ${url.includes("arm64") ? "0.20.3" : "0.20.2"}\n`)));
  expect(await publishedDesktopRelease("mac", new AbortController().signal)).toBeNull();
});

it("rejects HTTP errors rather than constructing a nonexistent installer link", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("version: 9.0.0\n", { status: 404 })));
  await expect(publishedDesktopRelease("windows", new AbortController().signal)).rejects.toThrow();
});

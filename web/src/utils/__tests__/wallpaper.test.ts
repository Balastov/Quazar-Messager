import { describe, expect, it } from "vitest";
import { pickWallpaper, wallpaperCss, type WallpaperSources } from "../wallpaper";

const none: WallpaperSources = {
  chatVisible: false,
  chatUrl: null,
  starVisible: false,
  starUrl: null,
  personalUrl: null,
};

describe("pickWallpaper", () => {
  it("falls back to the built-in wallpaper when nothing is set", () => {
    expect(pickWallpaper(none)).toBeNull();
  });

  it("uses the personal background everywhere by default", () => {
    expect(pickWallpaper({ ...none, personalUrl: "/me.jpg", chatVisible: true, starVisible: false })).toBe("/me.jpg");
  });

  it("an open chat with a shared background wins", () => {
    expect(pickWallpaper({ ...none, personalUrl: "/me.jpg", chatVisible: true, chatUrl: "blob:chat" })).toBe("blob:chat");
  });

  it("a chat background is not shown while the chat is off screen", () => {
    expect(pickWallpaper({ ...none, personalUrl: "/me.jpg", chatVisible: false, chatUrl: "blob:chat" })).toBe("/me.jpg");
  });

  it("an open Star with a background wins over the personal one", () => {
    expect(pickWallpaper({ ...none, personalUrl: "/me.jpg", starVisible: true, starUrl: "/star.jpg" })).toBe("/star.jpg");
    expect(pickWallpaper({ ...none, personalUrl: "/me.jpg", starVisible: true, starUrl: null })).toBe("/me.jpg");
  });
});

describe("wallpaperCss", () => {
  it("quotes the url safely", () => {
    expect(wallpaperCss('/a").jpg')).toContain('url("/a\\").jpg")');
  });
});

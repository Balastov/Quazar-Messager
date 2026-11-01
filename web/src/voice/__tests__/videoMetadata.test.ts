import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readVideoDuration } from "../videoMetadata";

let video: HTMLVideoElement;
beforeEach(() => {
  const create = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    const element = create(tag);
    if (tag === "video") video = element as HTMLVideoElement;
    return element;
  }) as typeof document.createElement);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:video-metadata-test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("uploaded video metadata", () => {
  it("reads duration before uploading and releases the temporary media URL", async () => {
    const pending = readVideoDuration(new File(["video"], "clip.mp4", { type: "video/mp4" }));
    Object.defineProperty(video, "duration", { configurable: true, value: 12.5 });
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(await pending).toBe(12.5);
    expect(video.getAttribute("src")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:video-metadata-test");
  });

  it("rejects unreadable or indefinite media with a useful error", async () => {
    const pending = readVideoDuration(new File(["video"], "clip.webm", { type: "video/webm" }));
    const rejected = expect(pending).rejects.toThrow("длительность");
    Object.defineProperty(video, "duration", { configurable: true, value: Infinity });
    video.dispatchEvent(new Event("loadedmetadata"));
    await rejected;
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("times out instead of leaving an upload stuck forever", async () => {
    vi.useFakeTimers();
    const pending = readVideoDuration(new File(["video"], "broken.mp4", { type: "video/mp4" }));
    const rejected = expect(pending).rejects.toThrow("Не удалось прочитать видео");
    vi.advanceTimersByTime(15001);
    await rejected;
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });
});

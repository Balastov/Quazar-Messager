import { describe, expect, it } from "vitest";
import type { FocusState, VideoState } from "../../../api/roomActivities";
import { boardPoint, containedVideo, focusAt, remaining, videoTime, wrapBoardText } from "../roomActivityMath";

const start = Date.parse("2026-11-01T12:00:00Z");
const focus: FocusState = { owner_id: "alice", version: 1, phase: "work", running: true,
  work_seconds: 60, break_seconds: 30, remaining_seconds: 60, ends_at: new Date(start + 60000).toISOString() };

describe("shared activity clocks and coordinates", () => {
  it("derives the same work, break and end deadlines even after a background-tab delay", () => {
    expect(remaining(focus, start + 20000)).toBe(40);
    expect(focusAt(focus, start + 61000)).toMatchObject({ phase: "break", version: 2, running: true });
    expect(remaining(focusAt(focus, start + 61000)!, start + 61000)).toBe(29);
    expect(focusAt(focus, start + 90000)).toMatchObject({ phase: "done", version: 3, running: false });
    expect(focus.phase).toBe("work");
  });

  it("preserves a paused clock regardless of elapsed wall time", () => {
    const paused = { ...focus, running: false, ends_at: null, remaining_seconds: 12 };
    expect(focusAt(paused, start + 3600000)).toBe(paused);
    expect(remaining(paused, start + 3600000)).toBe(12);
  });

  it("anchors video to server time and respects pause and duration", () => {
    const video: VideoState = { version: 1, owner_id: "alice", file_id: "v", playing: true,
      position: 10, duration: 100, updated_at: new Date(start).toISOString(), shared_controls: false };
    expect(videoTime(video, start + 5000)).toBe(15);
    expect(videoTime(video, start + 200000)).toBe(100);
    expect(videoTime({ ...video, playing: false }, start + 5000)).toBe(10);
  });

  it("excludes letterboxing so screen pointers remain aligned across aspect ratios", () => {
    expect(containedVideo(1000, 600, 1920, 1080)).toEqual({ left: 0, top: 18.75, width: 1000, height: 562.5 });
    expect(containedVideo(1000, 600, 800, 800)).toEqual({ left: 200, top: 0, width: 600, height: 600 });
    expect(containedVideo(0, 0, 0, 0)).toBeNull();
  });

  it("wraps note text without interpreting markup", () => {
    expect(wrapBoardText("<script>alert(1)</script>")[0]).toBe("<script>alert(1)</script>");
    expect(wrapBoardText("x".repeat(300)).length).toBe(7);
  });

  it("maps drawing coordinates correctly when a fullscreen board has side margins", () => {
    const rect = { left: 0, top: 0, width: 1600, height: 700 };
    expect(boardPoint(rect, 800, 350)).toEqual({ x: 600, y: 350 });
    expect(boardPoint(rect, 100, 350)).toBeNull();
    expect(boardPoint({ left: 0, top: 0, width: 0, height: 0 }, 10, 10)).toBeNull();
  });
});

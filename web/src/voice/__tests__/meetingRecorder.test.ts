import { AxiosError, type AxiosResponse } from "axios";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../store/voice", () => ({ roomMediaForRecording: () => ({ audio: [], screens: [] }) }));

import { baseMime, chooseType, ChunkUploader, fitRect, recordingLabel, type RecordingKind } from "../meetingRecorder";
import { durationText, keptUntil, recordingWhen } from "../../components/constellation/recordingText";

function refused(status: number, detail?: unknown) {
  return new AxiosError("refused", "ERR_BAD_REQUEST", undefined, undefined, {
    status,
    data: detail === undefined ? {} : { detail },
  } as AxiosResponse);
}

const offline = () => new AxiosError("Network Error", "ERR_NETWORK");
const blob = (text: string) => new Blob([text]);
const noWait = () => Promise.resolve();

describe("ChunkUploader", () => {
  it("sends chunks in order with their own numbers per kind", async () => {
    const sent: [RecordingKind, number, number][] = [];
    const up = new ChunkUploader(async (kind, seq, data) => void sent.push([kind, seq, data.size]), vi.fn(), noWait);
    up.push("video", blob("aaaa"));
    up.push("audio", blob("b"));
    up.push("video", blob("cc"));
    up.push("video", blob("")); // пустой кусок — не шлём
    await up.drain();
    expect(sent).toEqual([["video", 0, 4], ["audio", 0, 1], ["video", 1, 2]]);
    expect(up.pending).toBe(0);
  });

  it("retries the same chunk while there is no connection", async () => {
    let fails = 2;
    const sent: number[] = [];
    const up = new ChunkUploader(async (_kind, seq) => {
      if (fails-- > 0) throw offline();
      sent.push(seq);
    }, vi.fn(), noWait);
    up.push("audio", blob("x"));
    up.push("audio", blob("y"));
    await up.drain();
    expect(sent).toEqual([0, 1]);
  });

  it("stops with the server's reason when it refuses", async () => {
    const onDead = vi.fn();
    const up = new ChunkUploader(async () => {
      throw refused(507, "На сервере закончилось место — запись остановлена и сохранена");
    }, onDead, noWait);
    up.push("video", blob("x"));
    await up.drain();
    expect(up.dead).toBe(true);
    expect(onDead).toHaveBeenCalledWith("На сервере закончилось место — запись остановлена и сохранена");
    up.push("video", blob("late"));
    expect(up.pending).toBe(0);
  });

  it("treats a gap reply as stopped and gives up on the tail after the drain timeout", async () => {
    const gap = vi.fn();
    const first = new ChunkUploader(async () => { throw refused(409, { expected: 3 }); }, gap, noWait);
    first.push("video", blob("x"));
    await first.drain();
    expect(gap).toHaveBeenCalledWith("Запись остановлена");

    let now = 0;
    const tail = vi.fn();
    const second = new ChunkUploader(async () => { throw offline(); }, tail, async () => { now += 20_000; }, () => now);
    second.push("audio", blob("x"));
    await second.drain(60_000);
    expect(tail).toHaveBeenCalledWith(expect.stringContaining("Не удалось дослать"));
  });
});

describe("recording helpers", () => {
  it("picks the first supported type and stores its base mime", () => {
    const type = chooseType(["video/webm;codecs=vp9", "video/webm", "video/mp4"], (t) => t !== "video/webm;codecs=vp9");
    expect(type).toBe("video/webm");
    expect(chooseType(["a", "b"], () => false)).toBeNull();
    expect(baseMime("video/webm;codecs=vp8,opus")).toBe("video/webm");
  });

  it("letterboxes a screen into its slot", () => {
    expect(fitRect(1920, 1080, 0, 0, 1280, 720)).toEqual([0, 0, 1280, 720]);
    // Два экрана рядом: каждый в половине кадра, по центру по высоте.
    expect(fitRect(1920, 1080, 640, 0, 640, 720)).toEqual([640, 180, 640, 360]);
    expect(fitRect(1000, 2000, 0, 0, 1280, 720)).toEqual([460, 0, 360, 720]);
  });

  it("labels and describes recordings in local time", () => {
    const start = new Date(2026, 10, 21, 14, 5);
    expect(recordingLabel(start)).toBe("21.11 14:05");
    const end = new Date(2026, 10, 21, 15, 17);
    expect(recordingWhen({ started_at: start.toISOString(), ended_at: end.toISOString() })).toBe(
      "21.11, 14:05–15:17 · 1 ч 12 мин"
    );
    expect(recordingWhen({ started_at: start.toISOString(), ended_at: null })).toBe("21.11, с 14:05");
    expect(durationText(30_000)).toBe("меньше минуты");
    expect(durationText(2 * 3600_000)).toBe("2 ч");
    expect(keptUntil(start.toISOString())).toBe("до 19.02");
  });
});

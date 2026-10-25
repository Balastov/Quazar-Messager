import { describe, expect, it } from "vitest";
import {
  buildWave,
  detectVoiceMime,
  encodeVoice,
  formatDuration,
  parseVoice,
  voicePreview,
  WAVE_BARS,
  WAVE_MAX,
  type VoiceRef,
} from "../voice";

const ref: VoiceRef = {
  id: "0b6f1b8e-2a3c-4d5e-8f90-1234567890ab",
  key: "a2V5",
  mime: "audio/webm",
  dur: 12.4,
  size: 4096,
  wave: [0, 5, 31],
};

describe("voice payload", () => {
  it("round-trips", () => {
    expect(parseVoice(encodeVoice(ref))).toEqual(ref);
  });

  it("rejects foreign ids, unknown types and bad durations", () => {
    expect(parseVoice(encodeVoice({ ...ref, id: "../../etc" }))).toBeNull();
    expect(parseVoice(encodeVoice({ ...ref, mime: "text/html" as never }))).toBeNull();
    expect(parseVoice(encodeVoice({ ...ref, dur: 0 }))).toBeNull();
    expect(parseVoice("VOC1:{oops")).toBeNull();
    expect(parseVoice("привет")).toBeNull();
  });

  it("clamps the wave", () => {
    const out = parseVoice(encodeVoice({ ...ref, wave: [-3, 99, 7.6, "x" as never] }));
    expect(out?.wave).toEqual([0, WAVE_MAX, 8, 0]);
  });

  it("previews with duration", () => {
    expect(voicePreview(ref)).toBe("🎤 Голосовое 0:12");
    expect(formatDuration(75.4)).toBe("1:15");
    expect(formatDuration(0)).toBe("0:00");
  });
});

describe("detectVoiceMime", () => {
  const pad = (head: number[]) => new Uint8Array([...head, ...new Array(16).fill(0)]);
  it("knows WebM, Ogg and MP4 by signature", () => {
    expect(detectVoiceMime(pad([0x1a, 0x45, 0xdf, 0xa3]))).toBe("audio/webm");
    expect(detectVoiceMime(pad([...new TextEncoder().encode("OggS")]))).toBe("audio/ogg");
    expect(detectVoiceMime(pad([0, 0, 0, 0x20, ...new TextEncoder().encode("ftypM4A ")]))).toBe("audio/mp4");
  });
  it("refuses everything else", () => {
    expect(detectVoiceMime(pad([...new TextEncoder().encode("<html>")]))).toBeNull();
    expect(detectVoiceMime(new Uint8Array(4))).toBeNull();
  });
});

describe("buildWave", () => {
  it("downsamples to peaks normalised to the loudest", () => {
    const levels = Array.from({ length: 480 }, (_, i) => (i < 240 ? 0.05 : 0.2));
    const wave = buildWave(levels);
    expect(wave).toHaveLength(WAVE_BARS);
    expect(wave[0]).toBe(Math.round(0.25 * WAVE_MAX));
    expect(wave[WAVE_BARS - 1]).toBe(WAVE_MAX);
  });
  it("handles silence and very short recordings", () => {
    expect(buildWave([])).toEqual(new Array(WAVE_BARS).fill(0));
    expect(buildWave([0, 0, 0])).toEqual(new Array(WAVE_BARS).fill(0));
    expect(buildWave([0.5])).toHaveLength(WAVE_BARS);
  });
});

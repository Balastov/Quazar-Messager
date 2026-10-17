import { describe, expect, it } from "vitest";
import { SilenceWatchdog } from "../noiseSuppression";

const SPEECH = 0.2;
const SILENT_OUT = 0;

describe("SilenceWatchdog", () => {
  it("declares RNNoise working as soon as sound comes out", () => {
    const w = new SilenceWatchdog();
    expect(w.feed(SPEECH, SILENT_OUT, 200)).toBe("checking"); // модель ещё грузится
    expect(w.feed(SPEECH, 0.05, 200)).toBe("working");
    // Дальше законная тишина на выходе (подавленный шум) уже ничего не решает.
    expect(w.feed(SPEECH, SILENT_OUT, 10_000)).toBe("working");
  });

  it("fails after 3 s of speech with digital silence on the output", () => {
    const w = new SilenceWatchdog();
    for (let t = 0; t < 2800; t += 200) expect(w.feed(SPEECH, SILENT_OUT, 200)).toBe("checking");
    expect(w.feed(SPEECH, SILENT_OUT, 200)).toBe("failed");
  });

  it("does not decide while the person is silent", () => {
    const w = new SilenceWatchdog();
    for (let t = 0; t < 60_000; t += 200) expect(w.feed(0.0005, SILENT_OUT, 200)).toBe("checking");
  });

  it("counts only moments with speech", () => {
    const w = new SilenceWatchdog();
    for (let i = 0; i < 10; i++) w.feed(SPEECH, SILENT_OUT, 200); // 2 с речи
    for (let i = 0; i < 50; i++) w.feed(0, SILENT_OUT, 200); // пауза
    expect(w.state).toBe("checking");
    for (let i = 0; i < 5; i++) w.feed(SPEECH, SILENT_OUT, 200); // ещё 1 с
    expect(w.state).toBe("failed");
  });
});

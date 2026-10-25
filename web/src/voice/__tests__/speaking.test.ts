import { describe, expect, it } from "vitest";
import { rms, SPEAK_HOLD_MS, SPEAK_ON, SpeakingGate } from "../speaking";

describe("SpeakingGate", () => {
  it("turns on at the first loud sample, without waiting", () => {
    const gate = new SpeakingGate();
    expect(gate.update(0.001, 0)).toBe(false);
    expect(gate.update(SPEAK_ON, 50)).toBe(true);
  });

  it("holds through short pauses between words and then goes off", () => {
    const gate = new SpeakingGate();
    gate.update(0.1, 0);
    expect(gate.update(0.001, SPEAK_HOLD_MS - 50)).toBe(true);
    expect(gate.update(0.001, SPEAK_HOLD_MS + 1)).toBe(false);
  });
});

describe("rms", () => {
  it("measures loudness", () => {
    expect(rms(new Float32Array([0, 0, 0, 0]))).toBe(0);
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
  });
});

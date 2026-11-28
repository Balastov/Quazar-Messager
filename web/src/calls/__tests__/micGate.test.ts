import { describe, expect, it } from "vitest";
import { MicGate } from "../micGateWorklet.js";

const RATE = 48_000;
const BLOCK = 128;
const BLOCK_MS = (BLOCK / RATE) * 1000;

/** Синус заданной громкости (дБ RMS), блоками по 128 сэмплов. */
function tone(db: number, ms: number, phase = { t: 0 }): Float32Array[] {
  const amp = Math.SQRT2 * 10 ** (db / 20);
  const blocks: Float32Array[] = [];
  for (let n = 0; n < Math.ceil(ms / BLOCK_MS); n++) {
    const block = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) block[i] = amp * Math.sin((2 * Math.PI * 220 * phase.t++) / RATE);
    blocks.push(block);
  }
  return blocks;
}
const silence = (ms: number) => Array.from({ length: Math.ceil(ms / BLOCK_MS) }, () => new Float32Array(BLOCK));

/** Прогоняет блоки через порог, возвращает максимальную громкость на выходе (по модулю). */
function run(gate: MicGate, blocks: Float32Array[]): number {
  let max = 0;
  const out = new Float32Array(BLOCK);
  for (const block of blocks) {
    gate.process(block, out);
    for (const v of out) max = Math.max(max, Math.abs(v));
  }
  return max;
}

describe("MicGate", () => {
  it("passes everything through unchanged while off", () => {
    const gate = new MicGate(RATE, null);
    const input = tone(-60, 3)[0];
    const out = new Float32Array(BLOCK);
    gate.process(input, out);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it("stays silent for sound below the threshold", () => {
    const gate = new MicGate(RATE, -40);
    expect(run(gate, tone(-55, 1000))).toBe(0);
  });

  it("does not open for a short loud click (keyboard, gamepad)", () => {
    const gate = new MicGate(RATE, -50);
    expect(run(gate, [...silence(100), ...tone(-10, 8), ...silence(300)])).toBeLessThan(1e-3);
    expect(gate.open).toBe(false);
  });

  it("opens for sustained speech without cutting its beginning", () => {
    const gate = new MicGate(RATE, -50);
    run(gate, silence(200));
    const speech = tone(-30, 400);
    const out = new Float32Array(BLOCK);
    let firstLoud = -1;
    // Звук задержан на 30 мс: смотрим, когда на выходе появилось начало речи.
    [...speech, ...silence(100)].forEach((block, n) => {
      gate.process(block, out);
      if (firstLoud < 0 && out.some((v) => Math.abs(v) > 0.01)) firstLoud = n;
    });
    expect(gate.open).toBe(true);
    // Начало слова (через 30 мс задержки) уже звучит почти в полную силу.
    expect(firstLoud * BLOCK_MS).toBeLessThan(45);
  });

  it("holds through short pauses between words, then closes", () => {
    const gate = new MicGate(RATE, -50);
    run(gate, tone(-30, 300));
    expect(gate.open).toBe(true);
    run(gate, silence(150));
    expect(gate.open).toBe(true); // пауза между словами
    run(gate, silence(400));
    expect(gate.open).toBe(false);
    expect(run(gate, silence(200))).toBeLessThan(1e-4);
  });

  it("applies a new threshold on the fly and reports the level", () => {
    const gate = new MicGate(RATE, -20);
    run(gate, tone(-30, 300));
    expect(gate.open).toBe(false);
    expect(gate.takePeakDb()).toBeGreaterThan(-32);
    expect(gate.takePeakDb()).toBe(-100);
    gate.setThreshold(-40);
    run(gate, tone(-30, 300));
    expect(gate.open).toBe(true);
    gate.setThreshold(null);
    expect(gate.enabled).toBe(false);
  });
});

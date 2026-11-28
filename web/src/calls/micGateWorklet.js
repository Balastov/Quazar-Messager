/**
 * Порог микрофона (noise gate) — AudioWorklet после шумоподавления.
 *
 * Пока человек молчит, не пропускает ничего: ни клавиатуру, ни геймпад, ни мышь.
 * Короткие щелчки не открывают порог: громкость должна держаться выше него
 * OPEN_AFTER_MS подряд. Чтобы при этом не съедалось начало слова, звук задерживается
 * на LOOKAHEAD_MS — только пока порог включён.
 *
 * Обычный JS без импортов: Vite отдаёт файл как есть (?url), а тесты импортируют MicGate.
 */

const LOOKAHEAD_MS = 30;
/** Речь держит громкость десятки миллисекунд, щелчок клавиши — единицы. */
const OPEN_AFTER_MS = 30;
/** Окно усреднения громкости: не короче периода основного тона голоса. */
const WINDOW_MS = 10;
const HOLD_MS = 300;
const HYSTERESIS_DB = 6;
const ATTACK_MS = 3;
const RELEASE_MS = 60;
const METER_MS = 50;
const SILENCE_DB = -100;

export class MicGate {
  /**
   * @param {number} rate частота дискретизации
   * @param {number | null} thresholdDb порог в дБ (null — выключен)
   * @param {number} blockSize размер блока AudioWorklet
   */
  constructor(rate, thresholdDb = null, blockSize = 128) {
    this.rate = rate;
    this.blockMs = (blockSize / rate) * 1000;
    this.delay = new Float32Array(Math.round((rate * LOOKAHEAD_MS) / 1000));
    this.pos = 0;
    this.powers = new Float32Array(Math.max(1, Math.round(WINDOW_MS / this.blockMs)));
    this.powerPos = 0;
    this.attack = 1 - Math.exp(-1000 / (ATTACK_MS * rate));
    this.release = 1 - Math.exp(-1000 / (RELEASE_MS * rate));
    this.gain = 0;
    this.open = false;
    this.aboveMs = 0;
    this.holdMs = 0;
    /** Громкость (дБ) для индикатора: максимум с последнего чтения. */
    this.peakDb = SILENCE_DB;
    this.setThreshold(thresholdDb);
  }

  /** @param {number | null} thresholdDb */
  setThreshold(thresholdDb) {
    const enabled = typeof thresholdDb === "number" && Number.isFinite(thresholdDb);
    if (enabled && !this.enabled) {
      // Включили: начинаем с закрытого порога и пустой задержки.
      this.delay.fill(0);
      this.gain = 0;
      this.open = false;
      this.aboveMs = 0;
    }
    this.enabled = enabled;
    this.threshold = enabled ? thresholdDb : 0;
  }

  /** Громкость с последнего вызова (дБ), сбрасывает максимум. */
  takePeakDb() {
    const value = this.peakDb;
    this.peakDb = SILENCE_DB;
    return value;
  }

  /**
   * @param {Float32Array} input
   * @param {Float32Array} output
   */
  process(input, output) {
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    this.powers[this.powerPos] = sum / Math.max(1, input.length);
    this.powerPos = (this.powerPos + 1) % this.powers.length;
    let power = 0;
    for (let i = 0; i < this.powers.length; i++) power += this.powers[i];
    const levelDb = Math.max(SILENCE_DB, 10 * Math.log10(power / this.powers.length + 1e-12));
    if (levelDb > this.peakDb) this.peakDb = levelDb;

    if (!this.enabled) {
      output.set(input);
      return;
    }

    if (levelDb >= this.threshold) {
      this.aboveMs += this.blockMs;
      if (this.aboveMs >= OPEN_AFTER_MS) this.open = true;
    } else {
      this.aboveMs = 0;
    }
    if (this.open) {
      if (levelDb >= this.threshold - HYSTERESIS_DB) this.holdMs = HOLD_MS;
      else if ((this.holdMs -= this.blockMs) <= 0) this.open = false;
    }

    const target = this.open ? 1 : 0;
    const coef = this.open ? this.attack : this.release;
    const delay = this.delay;
    for (let i = 0; i < input.length; i++) {
      const delayed = delay[this.pos];
      delay[this.pos] = input[i];
      this.pos = (this.pos + 1) % delay.length;
      this.gain += (target - this.gain) * coef;
      output[i] = delayed * this.gain;
    }
  }
}

if (typeof AudioWorkletProcessor !== "undefined" && typeof registerProcessor === "function") {
  class MicGateProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      this.gate = new MicGate(sampleRate, options.processorOptions?.thresholdDb ?? null);
      this.meter = false;
      this.sinceMeter = 0;
      this.port.onmessage = (event) => {
        const data = event.data || {};
        if ("thresholdDb" in data) this.gate.setThreshold(data.thresholdDb);
        if ("meter" in data) this.meter = !!data.meter;
      };
    }

    process(inputs, outputs) {
      const input = inputs[0]?.[0];
      const output = outputs[0]?.[0];
      if (!output) return true;
      if (!input) {
        output.fill(0);
        return true;
      }
      this.gate.process(input, output);
      for (let ch = 1; ch < outputs[0].length; ch++) outputs[0][ch].set(output);
      if (this.meter && (this.sinceMeter += this.gate.blockMs) >= METER_MS) {
        this.sinceMeter = 0;
        this.port.postMessage({ levelDb: this.gate.takePeakDb(), open: !this.gate.enabled || this.gate.open });
      }
      return true;
    }
  }
  registerProcessor("quazar-mic-gate", MicGateProcessor);
}

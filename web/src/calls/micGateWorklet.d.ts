export declare class MicGate {
  constructor(rate: number, thresholdDb?: number | null, blockSize?: number);
  readonly blockMs: number;
  readonly enabled: boolean;
  readonly open: boolean;
  readonly gain: number;
  setThreshold(thresholdDb: number | null): void;
  takePeakDb(): number;
  process(input: Float32Array, output: Float32Array): void;
}

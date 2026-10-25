/**
 * Кто говорит на Планете — по громкости дорожек прямо в браузере.
 *
 * Сервер LiveKit тоже сообщает «говорит» (ActiveSpeakersChanged), но со сглаживанием
 * по несколько сотен миллисекунд — зелёный кружок загорался заметно позже голоса.
 * Здесь: раз в 50 мс RMS каждой дорожки; громче порога — говорит сразу, тише —
 * гаснет через SPEAK_HOLD_MS (паузы между словами не мигают).
 */

/** RMS, выше которого считаем речью (тишина с шумодавом ~0.001, речь 0.03–0.3). */
export const SPEAK_ON = 0.02;
/** Сколько держать «говорит» после последнего громкого замера. */
export const SPEAK_HOLD_MS = 350;
const TICK_MS = 50;

/** «Говорит» для одной дорожки: включается сразу, гаснет с задержкой. */
export class SpeakingGate {
  private lastLoud = -Infinity;

  update(level: number, now: number): boolean {
    if (level >= SPEAK_ON) this.lastLoud = now;
    return now - this.lastLoud < SPEAK_HOLD_MS;
  }
}

export function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

interface Entry {
  trackId: string;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  gate: SpeakingGate;
}

/**
 * Следит за дорожками, которые отдаёт sources() (userId → микрофонная дорожка),
 * и зовёт onChange, когда меняется набор говорящих.
 */
export class SpeakingMonitor {
  private ctx: AudioContext | null = null;
  private entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private speaking = new Set<string>();

  constructor(
    private sources: () => Map<string, MediaStreamTrack>,
    private onChange: (speaking: ReadonlySet<string>) => void
  ) {}

  start(): void {
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const e of this.entries.values()) e.source.disconnect();
    this.entries.clear();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.speaking = new Set();
  }

  /** Для этого человека громкость меряем сами (иначе — верим серверу). */
  measures(userId: string): boolean {
    return this.entries.has(userId);
  }

  isSpeaking(userId: string): boolean {
    return this.speaking.has(userId);
  }

  private tick(): void {
    const tracks = this.sources();
    // Дорожка пропала или сменилась (другой микрофон, шумодав отключился) — замер заново.
    for (const [userId, e] of this.entries) {
      if (tracks.get(userId)?.id !== e.trackId) {
        e.source.disconnect();
        this.entries.delete(userId);
      }
    }
    for (const [userId, track] of tracks) {
      if (!this.entries.has(userId) && track.readyState === "live") this.watch(userId, track);
    }

    const now = performance.now();
    const next = new Set<string>();
    for (const [userId, e] of this.entries) {
      e.analyser.getFloatTimeDomainData(e.samples);
      if (e.gate.update(rms(e.samples), now)) next.add(userId);
    }
    if (next.size !== this.speaking.size || [...next].some((id) => !this.speaking.has(id))) {
      this.speaking = next;
      this.onChange(next);
    }
  }

  private watch(userId: string, track: MediaStreamTrack): void {
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
      const source = this.ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      this.entries.set(userId, {
        trackId: track.id,
        source,
        analyser,
        samples: new Float32Array(analyser.fftSize),
        gate: new SpeakingGate(),
      });
    } catch {
      // Нет WebAudio — останется «говорит» от сервера.
    }
  }
}

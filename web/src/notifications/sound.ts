/**
 * Мягкий «стеклянный» chime через Web Audio API — без внешних файлов.
 */

let sharedCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  const AC =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  if (!sharedCtx) sharedCtx = new AC();
  return sharedCtx;
}

export async function playSoftChime(): Promise<void> {
  const ctx = getCtx();
  if (!ctx) return;

  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      return;
    }
  }

  const now = ctx.currentTime;
  // Тёплый мажорный арпеджио с длинным хвостом
  const notes = [
    { freq: 523.25, t: 0 }, // C5
    { freq: 659.25, t: 0.11 }, // E5
    { freq: 783.99, t: 0.22 }, // G5
  ];

  const master = ctx.createGain();
  master.gain.value = 0.55;
  master.connect(ctx.destination);

  for (const note of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc.type = "sine";
    osc.frequency.value = note.freq;

    filter.type = "lowpass";
    filter.frequency.value = 2200;
    filter.Q.value = 0.7;

    const t0 = now + note.t;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.05);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(master);

    osc.start(t0);
    osc.stop(t0 + 1.1);
  }
}

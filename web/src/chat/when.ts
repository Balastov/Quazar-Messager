/** Быстрый выбор времени для отложенной отправки и напоминаний. */

export interface WhenPreset {
  label: string;
  at: Date;
}

function at(base: Date, days: number, hours: number, minutes = 0): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

/** «Через час», «Сегодня вечером» (если ещё не поздно), «Завтра утром», «Завтра вечером», «Через неделю». */
export function whenPresets(now = new Date()): WhenPreset[] {
  const presets: WhenPreset[] = [{ label: "Через 1 час", at: new Date(now.getTime() + 3600_000) }];
  const tonight = at(now, 0, 20);
  // Сегодня в 20:00 — только если до него больше получаса.
  if (tonight.getTime() - now.getTime() > 30 * 60_000) presets.push({ label: "Сегодня в 20:00", at: tonight });
  presets.push({ label: "Завтра в 9:00", at: at(now, 1, 9) });
  presets.push({ label: "Завтра в 20:00", at: at(now, 1, 20) });
  presets.push({ label: "Через неделю", at: at(now, 7, 9) });
  return presets;
}

/** Значение для <input type="datetime-local"> в местном времени. */
export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** «сегодня в 20:00», «завтра в 9:05», «12 ноября в 9:00». */
export function formatWhen(iso: string | Date, now = new Date()): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const time = d.toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  if (diff === 0) return `сегодня в ${time}`;
  if (diff === 1) return `завтра в ${time}`;
  return `${d.toLocaleDateString("ru", { day: "numeric", month: "long" })} в ${time}`;
}

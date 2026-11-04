/** Public releases use three numeric components; compare numbers rather than text. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (value: string) => /^\d+\.\d+\.\d+$/.test(value) ? value.split(".").map(Number) : null;
  const next = parse(candidate), installed = parse(current);
  if (!next || !installed || ![...next, ...installed].every(Number.isSafeInteger)) return false;
  for (let index = 0; index < next.length; index++) {
    if (next[index] !== installed[index]) return next[index] > installed[index];
  }
  return false;
}

/**
 * Логирование без plaintext в production.
 */
const isProd = import.meta.env.PROD;

export function logError(context: string, err: unknown): void {
  if (isProd) {
    console.error(`[quazar] ${context}`);
    return;
  }
  console.error(`[quazar] ${context}`, err);
}

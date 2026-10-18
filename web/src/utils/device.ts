/** iPhone и iPad (iPadOS притворяется Mac, но у него есть сенсорный экран). */
export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
}

export function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

/** Телефон или планшет — там есть телефонная книга. */
export function isMobileDevice(): boolean {
  return isIOS() || isAndroid();
}

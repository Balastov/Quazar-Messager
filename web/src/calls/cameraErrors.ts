/** Почему не удалось включить камеру и что с этим сделать. */
export function cameraErrorText(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return (
        "Браузер не дал доступ к камере. Разрешите её: значок слева от адреса сайта → «Камера» → " +
        "«Разрешить». На Mac проверьте ещё: Системные настройки → Конфиденциальность и безопасность → " +
        "Камера → включите ваш браузер."
      );
    case "NotFoundError":
    case "OverconstrainedError":
      return "Камера не найдена. Подключите её или проверьте, что она включена в системе.";
    case "NotReadableError":
    case "AbortError":
      return "Камера занята другой программой (Zoom, Телемост, другая вкладка). Закройте её и попробуйте ещё раз.";
    default:
      return "Не удалось включить камеру. Попробуйте ещё раз.";
  }
}

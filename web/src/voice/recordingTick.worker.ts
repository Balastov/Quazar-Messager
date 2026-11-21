/**
 * Таймер для записи встречи: в фоновой вкладке браузер замедляет setInterval главного потока
 * до раза в секунду, а таймеры воркера — нет. Получает период в мс (0 — стоп), шлёт тики.
 */
let timer: ReturnType<typeof setInterval> | undefined;

self.onmessage = (event: MessageEvent<number>) => {
  clearInterval(timer);
  timer = event.data > 0 ? setInterval(() => self.postMessage(0), event.data) : undefined;
};

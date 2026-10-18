import type { WsEvent } from "../api/types";

type Handler = (event: WsEvent) => void;
type StatusHandler = (open: boolean) => void;

function wsUrl(token: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
}

class SocketManager {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private statusHandlers = new Set<StatusHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private token: string | null = null;
  /** Во время звонка переподключаемся чаще: на возврат даётся 10 секунд. */
  private fastReconnect = false;

  constructor() {
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => this.reconnectNow());
    }
  }

  connect(token: string) {
    this.token = token;
    this._open();
  }

  disconnect() {
    this.token = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Wait until WS is open (e.g. after opening from a push notification). */
  waitUntilOpen(timeoutMs = 8000): Promise<boolean> {
    if (this.isOpen()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (this.isOpen()) {
          resolve(true);
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  send(event: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  on(handler: Handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Соединение открылось (true) или оборвалось (false). */
  onStatus(handler: StatusHandler) {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  setFastReconnect(fast: boolean) {
    this.fastReconnect = fast;
  }

  /** Бросить текущее соединение (возможно, «зависшее») и сразу открыть новое. */
  reconnectNow() {
    if (!this.token) return;
    if (this.ws?.readyState === WebSocket.CONNECTING) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const old = this.ws;
    if (old) {
      old.onclose = null;
      old.onmessage = null;
      old.close();
      if (old.readyState !== WebSocket.CLOSED) this.statusHandlers.forEach((h) => h(false));
    }
    this._open();
  }

  private _open() {
    if (!this.token) return;
    const ws = new WebSocket(wsUrl(this.token));
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws === ws) this.statusHandlers.forEach((h) => h(true));
    };

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as WsEvent;
        this.handlers.forEach((h) => h(data));
      } catch {
        // ignore malformed frames
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.statusHandlers.forEach((h) => h(false));
      if (this.token) {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this._open(), this.fastReconnect ? 1000 : 3000);
      }
    };
  }
}

export const socket = new SocketManager();

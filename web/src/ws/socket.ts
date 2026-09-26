import type { WsEvent } from "../api/types";

type Handler = (event: WsEvent) => void;

function wsUrl(token: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
}

class SocketManager {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private token: string | null = null;

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

  send(event: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  on(handler: Handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private _open() {
    if (!this.token) return;
    this.ws = new WebSocket(wsUrl(this.token));

    this.ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as WsEvent;
        this.handlers.forEach((h) => h(data));
      } catch {
        // ignore malformed frames
      }
    };

    this.ws.onclose = () => {
      if (this.token) {
        this.reconnectTimer = setTimeout(() => this._open(), 3000);
      }
    };
  }
}

export const socket = new SocketManager();

export interface DesktopUpdate {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "up-to-date" | "error" | "disabled";
  currentVersion: string; version?: string; progress?: number; message?: string; manual: boolean; requested?: boolean;
}
export interface DesktopNavigation {
  kind?: string; chatId?: string; starId?: string; channelId?: string; callId?: string; messageId?: string; threadId?: string;
  door?: string; knockId?: string; lobbyChannelId?: string; action?: string;
}
export interface DesktopBridge {
  platform: string; version: string; serverOrigin: string;
  updateState(): Promise<DesktopUpdate>;
  checkForUpdates(): Promise<DesktopUpdate>;
  installUpdate(): Promise<{ ok: boolean; reason?: string }>;
  onUpdate(callback: (state: DesktopUpdate) => void): () => void;
  setSessionBusy(busy: boolean): void;
  showNotification(options: { title: string; body: string; tag: string; silent: boolean; data: DesktopNavigation }): Promise<boolean>;
  clearNotifications(): void;
  closeNotification(tag: string): void;
  onNavigate(callback: (route: DesktopNavigation) => void): () => void;
  openAuth(url: string): Promise<void>;
  takeAuthReturn(): Promise<string | null>;
  onAuthReturn(callback: (fragment: string) => void): () => void;
}
declare global { interface Window { quazarDesktop?: DesktopBridge } }
export function desktop(): DesktopBridge | undefined { return window.quazarDesktop; }
export function publicOrigin(): string { return desktop()?.serverOrigin ?? window.location.origin; }

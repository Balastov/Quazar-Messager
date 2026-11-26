// Оверлей поверх всех окон (как у Discord и TeamSpeak, но без внедрения в игры): кто в комнате и кто
// говорит. Прозрачное окно, клики проходят сквозь него, в показ экрана оно не попадает. Видно поверх
// обычных окон и игр в оконном режиме без рамки, но не поверх эксклюзивного полноэкранного режима.
const path = require('node:path');

const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const MAX_PEERS = 12;
const WIDTH = 240;
const MARGIN = 16;
// Высоты из overlay.html: отступы и рамка панели, строка названия, «Запись», строка участника, «и ещё N».
const PAD = 18, HEADER = 24, REC = 22, ROW = 28, MORE = 20;
const KEYS = { 'Control+Shift+M': 'mic', 'Control+Shift+D': 'deafen' };

const text = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

/** Что пришло из окна Quazar — только ожидаемые поля и разумные размеры. null — оверлей не нужен. */
function sanitizeOverlay(value) {
  if (!value || typeof value !== 'object') return null;
  const peers = (Array.isArray(value.peers) ? value.peers : []).slice(0, MAX_PEERS).map(peer => ({
    name: text(peer?.name, 60) || 'Участник',
    speaking: peer?.speaking === true,
    micOn: peer?.micOn === true,
    isLocal: peer?.isLocal === true,
    deafened: peer?.isLocal === true && peer?.deafened === true,
  }));
  return {
    enabled: value.enabled !== false,
    globalKeys: value.globalKeys !== false,
    corner: CORNERS.includes(value.corner) ? value.corner : 'top-left',
    room: text(value.room, 80),
    reconnecting: value.reconnecting === true,
    peers,
    more: Number.isInteger(value.more) && value.more > 0 ? Math.min(value.more, 999) : 0,
    recording: recording(value.recording),
  };
}

/** Кто записывает и с какого момента (мс), чтобы оверлей сам показывал, сколько идёт запись. */
function recording(value) {
  if (!value || typeof value !== 'object') return null;
  const since = typeof value.since === 'string' ? Date.parse(value.since) : NaN;
  return { by: text(value.by, 60) || 'Участник', since: Number.isFinite(since) ? since : null };
}

/** Где и какого размера окно: угол основного экрана, высота — по числу участников. */
function overlayBounds(state, area) {
  const height = PAD + HEADER + (state.recording ? REC : 0) + state.peers.length * ROW + (state.more ? MORE : 0);
  const left = state.corner.endsWith('left');
  const top = state.corner.startsWith('top');
  return {
    x: Math.round(left ? area.x + MARGIN : area.x + area.width - WIDTH - MARGIN),
    y: Math.round(top ? area.y + MARGIN : area.y + area.height - height - MARGIN),
    width: WIDTH,
    height,
  };
}

/** Окно Quazar перед глазами — оверлей не нужен, клавиши ловит само окно. */
function mainInFront(main) {
  return !!main && !main.isDestroyed() && main.isVisible() && !main.isMinimized() && main.isFocused();
}

class Overlay {
  constructor({ BrowserWindow, screen, globalShortcut, getMain, onHotkey, platform = process.platform }) {
    Object.assign(this, { BrowserWindow, screen, globalShortcut, getMain, onHotkey, platform });
    this.state = null;
    this.window = null;
    this.loaded = false;
    this.keysOn = false;
    this.sent = '';
    this.bounds = '';
  }

  /** Новое состояние комнаты из окна Quazar (null — вышли из комнаты). */
  update(value) {
    this.state = sanitizeOverlay(value);
    this.refresh();
  }

  /** Окно Quazar свернули, развернули, переключились на другое приложение и обратно. */
  refresh() {
    const away = !!this.state && !mainInFront(this.getMain());
    this.setKeys(away && this.state.globalKeys);
    if (away && this.state.enabled) this.show(); else this.hide();
  }

  show() {
    const win = this.ensureWindow();
    const bounds = overlayBounds(this.state, this.screen.getPrimaryDisplay().workArea);
    const key = JSON.stringify(bounds);
    if (key !== this.bounds) { win.setBounds(bounds); this.bounds = key; }
    this.send();
    if (!win.isVisible()) win.showInactive();
  }

  hide() {
    if (this.window && !this.window.isDestroyed() && this.window.isVisible()) this.window.hide();
  }

  send() {
    if (!this.loaded || !this.window || this.window.isDestroyed()) return;
    const payload = JSON.stringify(this.state);
    if (payload === this.sent) return;
    this.sent = payload;
    this.window.webContents.send('overlay:state', this.state);
  }

  ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const mac = this.platform === 'darwin';
    const win = new this.BrowserWindow({
      width: WIDTH, height: PAD + HEADER, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, focusable: false,
      skipTaskbar: true, hasShadow: false, alwaysOnTop: true, title: 'Quazar — оверлей', ...(mac ? { type: 'panel' } : {}),
      webPreferences: { preload: path.join(__dirname, 'overlay-preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    // Не попадает в показ экрана и в записи: зрители видят то, что под оверлеем.
    win.setContentProtection(true);
    if (mac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('did-finish-load', () => { this.loaded = true; this.sent = ''; this.send(); });
    win.on('closed', () => { if (this.window === win) { this.window = null; this.loaded = false; this.bounds = ''; } });
    this.window = win;
    void win.loadFile(path.join(__dirname, 'overlay.html')).catch(() => {});
    return win;
  }

  /** Ctrl+Shift+M и Ctrl+Shift+D в других программах — только пока я в комнате и окно Quazar не впереди. */
  setKeys(on) {
    if (on === this.keysOn) return;
    this.keysOn = on;
    for (const [accelerator, action] of Object.entries(KEYS)) {
      if (!on) { if (this.globalShortcut.isRegistered(accelerator)) this.globalShortcut.unregister(accelerator); continue; }
      // Клавиши заняты другой программой — внутри Quazar они всё равно работают.
      try { this.globalShortcut.register(accelerator, () => this.onHotkey(action)); } catch { /* занято */ }
    }
  }

  dispose() {
    this.setKeys(false);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}

module.exports = { Overlay, sanitizeOverlay, overlayBounds, mainInFront, CORNERS, MAX_PEERS };

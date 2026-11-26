// Оверлей поверх всех окон (как у Discord и TeamSpeak, но без внедрения в игры): кто в комнате и кто
// говорит, а ещё стук, звонки, приглашения и «Скоро встреча» с кнопками. Прозрачное окно: клики проходят
// сквозь него везде, кроме кнопок; в показ экрана оно не попадает. Видно поверх обычных окон и игр
// в оконном режиме без рамки, но не поверх эксклюзивного полноэкранного режима.
const path = require('node:path');

const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const MAX_PEERS = 12;
const MAX_TOASTS = 3;
const WIDTH = 240;
const MARGIN = 16;
// Высоты из overlay.html (рамки — тенью, места не занимают):
// панель — отступы, название, «Запись», «Фокус», строка участника, «и ещё N», строка «Перетащите»;
// всплывашка — отступы, заголовок (у сообщения — две строки), подпись, ряд кнопок; GAP — между блоками.
const PAD = 16, HEADER = 24, REC = 22, FOCUS = 22, ROW = 28, MORE = 20, PLACE = 30;
const TOAST_PAD = 16, TITLE = 18, INFO_TITLE = 34, SUB = 16, ACTIONS = 30, GAP = 6;
const KEYS = { 'Control+Shift+M': 'mic', 'Control+Shift+D': 'deafen' };
// Размер оверлея и непрозрачность фона панели (%), по умолчанию — как в первой версии.
const SCALES = [0.75, 1, 1.25, 1.5];
const OPACITY = 78;
const TOAST_KINDS = ['call', 'knock', 'invite', 'meeting', 'info'];
const TONES = ['primary', 'danger', 'plain'];
// Сколько длится «Переставить», если «Готово» так и не нажали.
const PLACE_MS = 120_000;
// Что показать при перестановке, если я не в комнате: размер и вид — как в разговоре.
const SAMPLE = { room: 'Оверлей Quazar', peers: [
  { name: 'Ваше имя', speaking: false, micOn: true, isLocal: true, deafened: false, sharing: false },
  { name: 'Собеседник', speaking: true, micOn: true, isLocal: false, deafened: false, sharing: false }] };

const text = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const coordinate = value => (Number.isInteger(value) && Math.abs(value) <= 100_000 ? value : null);

/** Что пришло из окна Quazar — только ожидаемые поля и разумные размеры. null — оверлей не нужен. */
function sanitizeOverlay(value) {
  if (!value || typeof value !== 'object') return null;
  const peers = (Array.isArray(value.peers) ? value.peers : []).slice(0, MAX_PEERS).map(peer => ({
    name: text(peer?.name, 60) || 'Участник',
    speaking: peer?.speaking === true,
    micOn: peer?.micOn === true,
    isLocal: peer?.isLocal === true,
    deafened: peer?.isLocal === true && peer?.deafened === true,
    sharing: peer?.sharing === true,
  }));
  const x = coordinate(value.position?.x), y = coordinate(value.position?.y);
  const custom = value.corner === 'custom' && x !== null && y !== null;
  return {
    enabled: value.enabled !== false,
    globalKeys: value.globalKeys !== false,
    corner: custom ? 'custom' : CORNERS.includes(value.corner) ? value.corner : 'top-left',
    // Своё место (после «Переставить»): левый верхний угол оверлея от угла рабочей области монитора.
    position: custom ? { x, y } : null,
    // null — я не в комнате и не в звонке: в оверлее только всплывашки.
    room: value.room === null ? null : text(value.room, 80),
    reconnecting: value.reconnecting === true,
    peers: value.room === null ? [] : peers,
    more: value.room !== null && Number.isInteger(value.more) && value.more > 0 ? Math.min(value.more, 999) : 0,
    recording: value.room === null ? null : recording(value.recording),
    focus: value.room === null ? null : focus(value.focus),
    toasts: toasts(value.toasts),
    scale: SCALES.includes(value.scale) ? value.scale : 1,
    opacity: Number.isInteger(value.opacity) && value.opacity >= 20 && value.opacity <= 100 ? value.opacity : OPACITY,
    // Какой монитор (id из screen.getAllDisplays); null или исчезнувший монитор — основной.
    display: Number.isSafeInteger(value.display) ? value.display : null,
  };
}

/** Кто записывает и с какого момента (мс), чтобы оверлей сам показывал, сколько идёт запись. */
function recording(value) {
  if (!value || typeof value !== 'object') return null;
  const since = typeof value.since === 'string' ? Date.parse(value.since) : NaN;
  return { by: text(value.by, 60) || 'Участник', since: Number.isFinite(since) ? since : null };
}

/** «Орбита фокуса» комнаты: фаза и когда она закончится (мс, часы этого компьютера) или сколько осталось на паузе. */
function focus(value) {
  if (!value || typeof value !== 'object' || !['work', 'break'].includes(value.phase)) return null;
  const running = value.running === true;
  return {
    phase: value.phase,
    running,
    endsAt: running && Number.isFinite(value.endsAt) ? value.endsAt : null,
    remaining: Number.isFinite(value.remaining) ? Math.max(0, Math.min(Math.round(value.remaining), 24 * 3600)) : 0,
  };
}

/** Всплывашки: стук, звонок, приглашение, встреча, сообщение. Кнопки — до трёх, с короткими подписями. */
function toasts(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, MAX_TOASTS).map(toast => ({
    id: text(toast?.id, 120),
    kind: TOAST_KINDS.includes(toast?.kind) ? toast.kind : 'info',
    title: text(toast?.title, 160),
    sub: text(toast?.sub, 160),
    actions: (Array.isArray(toast?.actions) ? toast.actions : []).slice(0, 3)
      .map(action => ({ id: text(action?.id, 20), label: text(action?.label, 20), tone: TONES.includes(action?.tone) ? action.tone : 'plain' }))
      .filter(action => action.id && action.label),
  })).filter(toast => toast.id && toast.title && !seen.has(toast.id) && seen.add(toast.id));
}

/** Высота всплывашки — как её рисует overlay.html. */
function toastHeight(toast) {
  return TOAST_PAD + (toast.kind === 'info' ? INFO_TITLE : TITLE) + (toast.sub ? SUB : 0) + (toast.actions.length ? ACTIONS : 0);
}

/** Высота панели комнаты; null — панели нет (не в комнате и не переставляем). */
function panelHeight(state, placing) {
  if (state.room === null) return null;
  return PAD + HEADER + (state.recording ? REC : 0) + (state.focus ? FOCUS : 0) + state.peers.length * ROW + (state.more ? MORE : 0) + (placing ? PLACE : 0);
}

/** Где и какого размера окно: угол выбранного экрана или своё место, высота — по содержимому, всё — в масштабе. */
function overlayBounds(state, area, placing = false) {
  const scale = state.scale ?? 1;
  const blocks = [panelHeight(state, placing), ...(state.toasts ?? []).map(toastHeight)].filter(height => height !== null);
  const content = blocks.reduce((sum, height) => sum + height, 0) + GAP * Math.max(0, blocks.length - 1);
  const width = Math.ceil(WIDTH * scale);
  const height = Math.max(1, Math.ceil(content * scale));
  const clampX = x => Math.round(Math.min(Math.max(x, area.x), area.x + area.width - width));
  const clampY = y => Math.round(Math.min(Math.max(y, area.y), area.y + area.height - height));
  if (state.corner === 'custom' && state.position) {
    return { x: clampX(area.x + state.position.x), y: clampY(area.y + state.position.y), width, height };
  }
  const left = state.corner.endsWith('left');
  const top = state.corner.startsWith('top');
  return {
    x: Math.round(left ? area.x + MARGIN : area.x + area.width - width - MARGIN),
    y: Math.round(top ? area.y + MARGIN : area.y + area.height - height - MARGIN),
    width,
    height,
  };
}

/** Мониторы для настроек: «1. DELL U2720Q — 2560×1440 (основной)». */
function displayList(screen) {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display, index) => {
    const label = text(display.label, 60) || 'Монитор';
    const { width, height } = display.size ?? display.bounds;
    return { id: display.id, name: `${index + 1}. ${label} — ${width}×${height}${display.id === primary ? ' (основной)' : ''}`, primary: display.id === primary };
  });
}

/** Выбранный монитор; если его отключили — основной. */
function pickDisplay(screen, id) {
  return (id != null && screen.getAllDisplays?.().find(display => display.id === id)) || screen.getPrimaryDisplay();
}

/** Окно Quazar перед глазами — оверлей не нужен, клавиши ловит само окно. */
function mainInFront(main) {
  return !!main && !main.isDestroyed() && main.isVisible() && !main.isMinimized() && main.isFocused();
}

class Overlay {
  constructor({ BrowserWindow, screen, globalShortcut, getMain, onHotkey, onKeys = () => {}, onAction = () => {}, onMoved = () => {},
    onPlacing = () => {}, platform = process.platform, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { BrowserWindow, screen, globalShortcut, getMain, onHotkey, onKeys, onAction, onMoved, onPlacing, platform, setTimer, clearTimer });
    this.state = null;
    this.window = null;
    this.loaded = false;
    this.keysOn = false;
    this.sent = '';
    this.bounds = '';
    this.taken = '[]';
    this.placing = false;
    this.placeTimer = null;
    // Подключили или отключили монитор, сменили разрешение — оверлей встаёт на место.
    for (const name of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.on?.(name, () => { this.bounds = ''; this.refresh(); });
    }
  }

  /** Новое состояние из окна Quazar (null — вышли из аккаунта или окно перезагружается). */
  update(value) {
    this.state = sanitizeOverlay(value);
    this.refresh();
  }

  /** Окно Quazar свернули, развернули, переключились на другое приложение и обратно. */
  refresh() {
    const away = !!this.state && !mainInFront(this.getMain());
    this.setKeys(away && this.state.globalKeys && this.state.room !== null);
    const content = !!this.state && (this.state.room !== null || this.state.toasts.length > 0);
    if (this.placing || (away && this.state.enabled && content)) this.show(); else this.hide();
  }

  /** Что рисовать: при перестановке вне комнаты — пример, чтобы было за что тянуть. */
  view() {
    const state = this.state ?? sanitizeOverlay({ room: null });
    const shown = this.placing && state.room === null ? { ...state, ...SAMPLE } : state;
    return { ...shown, placing: this.placing };
  }

  show() {
    const win = this.ensureWindow();
    const view = this.view();
    const bounds = overlayBounds(view, pickDisplay(this.screen, view.display).workArea, this.placing);
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
    const view = this.view();
    const payload = JSON.stringify(view);
    if (payload === this.sent) return;
    this.sent = payload;
    this.window.webContents.send('overlay:state', view);
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
    // Клики проходят насквозь; движения мыши окно всё равно видит, чтобы поймать кнопку под курсором.
    win.setIgnoreMouseEvents(!this.placing, { forward: true });
    // Не попадает в показ экрана и в записи: зрители видят то, что под оверлеем.
    win.setContentProtection(true);
    if (mac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('did-finish-load', () => { this.loaded = true; this.sent = ''; this.send(); });
    win.on('moved', () => this.moved());
    win.on('closed', () => { if (this.window === win) { this.window = null; this.loaded = false; this.bounds = ''; } });
    this.window = win;
    void win.loadFile(path.join(__dirname, 'overlay.html')).catch(() => {});
    return win;
  }

  /** Сообщение пришло из страницы оверлея, а не откуда-то ещё. */
  fromOverlay(event) {
    return !!this.window && !this.window.isDestroyed() && event?.sender === this.window.webContents;
  }

  /** Курсор над кнопкой — окно ловит клик; ушёл — снова пропускает клики насквозь. */
  hover(on) {
    if (this.placing || !this.window || this.window.isDestroyed()) return;
    this.window.setIgnoreMouseEvents(!on, { forward: true });
  }

  /** Нажали кнопку во всплывашке — только ту, что сейчас на экране. */
  action(toastId, actionId) {
    if (toastId === 'placing' && actionId === 'done') { this.place(false); return; }
    const toast = this.state?.toasts.find(item => item.id === toastId);
    if (!toast || !toast.actions.some(item => item.id === actionId)) return;
    this.onAction({ toast: toastId, action: actionId });
  }

  /** «Переставить»: оверлей виден и перетаскивается, пока не нажмут «Готово» (или две минуты). */
  place(on) {
    on = on === true;
    if (on === this.placing) return;
    this.placing = on;
    this.clearTimer(this.placeTimer);
    this.placeTimer = on ? this.setTimer(() => this.place(false), PLACE_MS) : null;
    const win = this.ensureWindow();
    win.setMovable?.(on);
    win.setIgnoreMouseEvents(!on, { forward: true });
    this.bounds = '';
    this.refresh();
    this.onPlacing(on);
  }

  /** Оверлей перетащили: запоминаем место относительно монитора, на котором он оказался. */
  moved() {
    if (!this.placing || !this.window || this.window.isDestroyed()) return;
    const bounds = this.window.getBounds();
    const display = this.screen.getDisplayMatching?.(bounds) ?? this.screen.getPrimaryDisplay();
    const position = { x: Math.round(bounds.x - display.workArea.x), y: Math.round(bounds.y - display.workArea.y) };
    this.bounds = JSON.stringify(bounds);
    // Окно Quazar пришлёт то же самое; до тех пор оверлей не прыгает обратно в угол.
    if (this.state) this.state = { ...this.state, corner: 'custom', position, display: display.id };
    this.onMoved({ display: display.id, ...position });
  }

  /** Ctrl+Shift+M и Ctrl+Shift+D в других программах — только пока я в комнате и окно Quazar не впереди. */
  setKeys(on) {
    if (on === this.keysOn) return;
    this.keysOn = on;
    const taken = [];
    for (const [accelerator, action] of Object.entries(KEYS)) {
      if (!on) { if (this.globalShortcut.isRegistered(accelerator)) this.globalShortcut.unregister(accelerator); continue; }
      // Клавиши заняты другой программой — внутри Quazar они всё равно работают; окно Quazar об этом скажет.
      let ok = false;
      try { ok = this.globalShortcut.register(accelerator, () => this.onHotkey(action)) !== false; } catch { /* занято */ }
      if (!ok) taken.push(action);
    }
    // Клавиши сняли (окно Quazar впереди) — последний результат остаётся в силе.
    if (!on) return;
    const key = JSON.stringify(taken);
    if (key !== this.taken) { this.taken = key; this.onKeys(taken); }
  }

  dispose() {
    this.setKeys(false);
    this.clearTimer(this.placeTimer);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}

module.exports = { Overlay, sanitizeOverlay, overlayBounds, toastHeight, displayList, pickDisplay, mainInFront, CORNERS, MAX_PEERS, MAX_TOASTS, SCALES };

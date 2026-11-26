const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Overlay, sanitizeOverlay, overlayBounds, toastHeight, displayList, MAX_PEERS } = require('../src/overlay.cjs');

const AREA = { x: 0, y: 25, width: 1440, height: 875 };
const room = (patch = {}) => ({ enabled: true, globalKeys: true, corner: 'top-left', room: 'Переговорная', reconnecting: false,
  peers: [{ name: 'Анна', speaking: true, micOn: true, isLocal: true }, { name: 'Боб', speaking: false, micOn: false, isLocal: false }], more: 0, ...patch });

class FakeWindow {
  static created = [];
  constructor(options) { this.options = options; this.visible = false; this.calls = []; this.sent = []; this.destroyed = false; this.handlers = {};
    this.webContents = { send: (channel, value) => this.sent.push([channel, value]), setWindowOpenHandler() {}, on: (name, fn) => { this.handlers[name] = fn; } };
    FakeWindow.created.push(this); }
  setAlwaysOnTop(...args) { this.calls.push(['alwaysOnTop', ...args]); }
  setIgnoreMouseEvents(value, options) { this.calls.push(['ignoreMouse', value]); this.ignore = value; this.forward = options?.forward; }
  setMovable(value) { this.movable = value; }
  getBounds() { return this.bounds; }
  setContentProtection(value) { this.calls.push(['contentProtection', value]); }
  setVisibleOnAllWorkspaces(...args) { this.calls.push(['allWorkspaces', ...args]); }
  setBounds(bounds) { this.bounds = bounds; }
  loadFile() { setImmediate(() => this.handlers['did-finish-load']?.()); return Promise.resolve(); }
  on(name, fn) { this.events = { ...this.events, [name]: fn }; }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  showInactive() { this.visible = true; this.calls.push(['showInactive']); }
  show() { throw new Error('оверлей не должен забирать фокус'); }
  hide() { this.visible = false; }
  destroy() { this.destroyed = true; }
}
const SECOND = { id: 2779098405, label: 'DELL U2720Q', size: { width: 2560, height: 1440 }, workArea: { x: 1440, y: 0, width: 2560, height: 1400 } };
function setup({ focused = false, platform = 'darwin' } = {}) {
  FakeWindow.created = [];
  const main = { focused, isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, isFocused: () => main.focused };
  const keys = new Map();
  const globalShortcut = { register: (acc, fn) => { keys.set(acc, fn); return true; }, unregister: acc => keys.delete(acc), isRegistered: acc => keys.has(acc) };
  const hotkeys = [], taken = [], actions = [], moved = [], placing = [], timers = [];
  const primary = { id: 1, label: 'Встроенный дисплей', size: { width: 1440, height: 900 }, workArea: AREA };
  const screenEvents = {};
  const screen = { displays: [primary, SECOND], getPrimaryDisplay: () => primary, getAllDisplays: () => screen.displays, on: (name, fn) => { screenEvents[name] = fn; },
    getDisplayMatching: bounds => screen.displays.find(d => bounds.x >= d.workArea.x && bounds.x < d.workArea.x + d.workArea.width) ?? primary };
  const overlay = new Overlay({ BrowserWindow: FakeWindow, screen, globalShortcut,
    getMain: () => main, onHotkey: action => hotkeys.push(action), onKeys: list => taken.push(list), platform,
    onAction: value => actions.push(value), onMoved: value => moved.push(value), onPlacing: on => placing.push(on),
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  return { overlay, main, keys, hotkeys, taken, screen, screenEvents, globalShortcut, actions, moved, placing, timers };
}

test('sanitizes renderer state: bounded strings, booleans and peer count', () => {
  assert.equal(sanitizeOverlay(null), null);
  const peers = Array.from({ length: 40 }, (_, i) => ({ name: `<b>${'x'.repeat(100)}\n${i}`, speaking: 'yes', micOn: 1, deafened: true }));
  const out = sanitizeOverlay({ corner: 'center', room: 42, peers, more: -3, extra: 'file:///etc/passwd' });
  assert.equal(out.peers.length, MAX_PEERS);
  assert.equal(out.peers[0].name.length, 60);
  assert.ok(!out.peers[0].name.includes('\n'));
  assert.deepEqual({ ...out.peers[0], name: '' }, { name: '', speaking: false, micOn: false, isLocal: false, deafened: false, sharing: false });
  assert.deepEqual({ corner: out.corner, room: out.room, more: out.more, enabled: out.enabled, extra: out.extra }, { corner: 'top-left', room: '', more: 0, enabled: true, extra: undefined });
});

test('window sits in the chosen corner and grows with the participants', () => {
  const top = overlayBounds(sanitizeOverlay(room()), AREA);
  assert.deepEqual(top, { x: 16, y: 41, width: 240, height: 16 + 24 + 2 * 28 });
  const bottom = overlayBounds(sanitizeOverlay(room({ corner: 'bottom-right', more: 3 })), AREA);
  assert.equal(bottom.x, 1440 - 240 - 16);
  assert.equal(bottom.y + bottom.height, 25 + 875 - 16);
  assert.equal(bottom.height, top.height + 20);
});

test('shown without focus, click-through, over full-screen spaces and hidden from screen sharing', async () => {
  const { overlay } = setup();
  overlay.update(room());
  const win = FakeWindow.created[0];
  assert.equal(win.visible, true);
  assert.equal(win.options.focusable, false);
  assert.equal(win.options.transparent, true);
  assert.deepEqual(win.calls.filter(c => c[0] !== 'showInactive'), [
    ['alwaysOnTop', true, 'screen-saver'], ['ignoreMouse', true], ['contentProtection', true],
    ['allWorkspaces', true, { visibleOnFullScreen: true, skipTransformProcessType: true }]]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(win.sent.at(-1)[0], 'overlay:state');
  assert.equal(win.sent.at(-1)[1].room, 'Переговорная');
  // То же состояние ещё раз — окну ничего не шлём.
  overlay.update(room());
  assert.equal(win.sent.length, 1);
});

test('hidden while the Quazar window is in front, when turned off and after leaving the room', () => {
  const { overlay, main } = setup({ focused: true });
  overlay.update(room());
  assert.equal(FakeWindow.created.length, 0);
  main.focused = false; overlay.refresh();
  const win = FakeWindow.created[0];
  assert.equal(win.visible, true);
  main.focused = true; overlay.refresh();
  assert.equal(win.visible, false);
  main.focused = false; overlay.update(room({ enabled: false }));
  assert.equal(win.visible, false);
  overlay.update(room()); assert.equal(win.visible, true);
  overlay.update(null); assert.equal(win.visible, false);
});

test('Ctrl+Shift+M / Ctrl+Shift+D are global only while in a room and Quazar is not in front', () => {
  const { overlay, main, keys, hotkeys } = setup({ focused: true, platform: 'win32' });
  overlay.update(room());
  assert.equal(keys.size, 0);
  main.focused = false; overlay.refresh();
  assert.deepEqual([...keys.keys()].sort(), ['Control+Shift+D', 'Control+Shift+M']);
  keys.get('Control+Shift+M')(); keys.get('Control+Shift+D')();
  assert.deepEqual(hotkeys, ['mic', 'deafen']);
  // Оверлей выключен, клавиши — нет: они настраиваются отдельно.
  overlay.update(room({ enabled: false }));
  assert.equal(keys.size, 2);
  overlay.update(room({ globalKeys: false }));
  assert.equal(keys.size, 0);
  overlay.update(room()); assert.equal(keys.size, 2);
  overlay.update(null); assert.equal(keys.size, 0);
  assert.equal(FakeWindow.created[0].calls.some(c => c[0] === 'allWorkspaces'), false);
});

test('a hotkey taken by another program does not break the overlay', () => {
  const { overlay } = setup();
  overlay.globalShortcut.register = () => { throw new Error('taken'); };
  assert.doesNotThrow(() => overlay.update(room()));
  assert.equal(FakeWindow.created[0].visible, true);
});

test('recording line: who records and since when, window grows by one line', () => {
  const out = sanitizeOverlay(room({ recording: { by: 'Боб\u0007', since: '2026-11-26T10:00:00Z', extra: 1 } }));
  assert.deepEqual(out.recording, { by: 'Боб', since: Date.parse('2026-11-26T10:00:00Z') });
  assert.deepEqual(sanitizeOverlay(room({ recording: { since: 'вчера' } })).recording, { by: 'Участник', since: null });
  assert.equal(sanitizeOverlay(room({ recording: 'yes' })).recording, null);
  assert.equal(overlayBounds(out, AREA).height, overlayBounds(sanitizeOverlay(room()), AREA).height + 22);
});

test('size and background: allowed scales and opacity only, window grows with the scale', () => {
  const out = sanitizeOverlay(room({ scale: 1.5, opacity: 40 }));
  assert.deepEqual([out.scale, out.opacity], [1.5, 40]);
  assert.deepEqual([sanitizeOverlay(room({ scale: 7, opacity: 5 })).scale, sanitizeOverlay(room({ scale: 7, opacity: 5 })).opacity], [1, 78]);
  assert.equal(sanitizeOverlay(room({ opacity: 55.5 })).opacity, 78);
  const normal = overlayBounds(sanitizeOverlay(room({ corner: 'bottom-right' })), AREA);
  const big = overlayBounds(sanitizeOverlay(room({ corner: 'bottom-right', scale: 1.5 })), AREA);
  assert.deepEqual([big.width, big.height], [360, Math.ceil(normal.height * 1.5)]);
  // Угол тот же: правый нижний край не уезжает за экран.
  assert.equal(big.x + big.width, normal.x + normal.width);
  assert.equal(big.y + big.height, normal.y + normal.height);
});

test('chosen monitor; unplugged monitor falls back to the primary one, plugging it back moves the overlay', () => {
  const { overlay, screen, screenEvents } = setup();
  assert.deepEqual(displayList(screen).map(d => d.name), ['1. Встроенный дисплей — 1440×900 (основной)', '2. DELL U2720Q — 2560×1440']);
  assert.equal(sanitizeOverlay(room({ display: 'DELL' })).display, null);
  overlay.update(room({ display: SECOND.id }));
  const win = FakeWindow.created[0];
  assert.deepEqual([win.bounds.x, win.bounds.y], [1440 + 16, 16]);
  screen.displays = [screen.getPrimaryDisplay()];
  screenEvents['display-removed']();
  assert.deepEqual([win.bounds.x, win.bounds.y], [16, 25 + 16]);
  screen.displays = [screen.getPrimaryDisplay(), SECOND];
  screenEvents['display-added']();
  assert.equal(win.bounds.x, 1440 + 16);
});

test('tells the Quazar window which global keys another program has taken', () => {
  const { overlay, main, taken, globalShortcut, keys } = setup({ platform: 'win32' });
  globalShortcut.register = (acc, fn) => { if (acc === 'Control+Shift+M') return false; keys.set(acc, fn); return true; };
  overlay.update(room());
  assert.deepEqual(taken, [['mic']]);
  // Окно Quazar впереди — клавиши сняты, но «занята» не сбрасываем; снова ушли — без повтора.
  main.focused = true; overlay.refresh();
  main.focused = false; overlay.refresh();
  assert.deepEqual(taken, [['mic']]);
  globalShortcut.register = (acc, fn) => { keys.set(acc, fn); return true; };
  main.focused = true; overlay.refresh(); main.focused = false; overlay.refresh();
  assert.deepEqual(taken, [['mic'], []]);
});

test('screen sharing mark and focus timer line', () => {
  const out = sanitizeOverlay(room({ peers: [{ name: 'Боб', sharing: true }], focus: { phase: 'work', running: true, endsAt: 1_800_000, remaining: 99.6, x: 1 } }));
  assert.equal(out.peers[0].sharing, true);
  assert.deepEqual(out.focus, { phase: 'work', running: true, endsAt: 1_800_000, remaining: 100 });
  assert.deepEqual(sanitizeOverlay(room({ focus: { phase: 'break', running: false, endsAt: 5, remaining: -3 } })).focus, { phase: 'break', running: false, endsAt: null, remaining: 0 });
  assert.equal(sanitizeOverlay(room({ focus: { phase: 'done' } })).focus, null);
  assert.equal(overlayBounds(out, AREA).height, overlayBounds(sanitizeOverlay(room({ peers: [{ name: 'Боб' }] })), AREA).height + 22);
});

const knock = (patch = {}) => ({ id: 'knock:k1', kind: 'knock', title: 'Боб стучится', sub: 'в «Переговорную» · Офис',
  actions: [{ id: 'admit', label: 'Впустить', tone: 'primary' }, { id: 'wait', label: 'В ожидание' }, { id: 'deny', label: 'Отказать', tone: 'danger' }], ...patch });

test('toasts: at most three, known kinds and tones, short labels, no duplicates; no room — no people', () => {
  const many = [knock(), knock(), knock({ id: 'call:c1', kind: 'call' }), knock({ id: 'x', kind: 'evil', actions: [{ id: 'go', label: 'y'.repeat(50), tone: 'red' }, {}] }), knock({ id: 'z' })];
  const out = sanitizeOverlay(room({ toasts: many }));
  assert.deepEqual(out.toasts.map(t => [t.id, t.kind]), [['knock:k1', 'knock'], ['call:c1', 'call']]);
  const odd = sanitizeOverlay(room({ toasts: [many[3]] })).toasts[0];
  assert.deepEqual([odd.kind, odd.actions.length, odd.actions[0].label.length, odd.actions[0].tone], ['info', 1, 20, 'plain']);
  const alone = sanitizeOverlay(room({ room: null, recording: { by: 'Боб' }, more: 3, toasts: [knock()] }));
  assert.deepEqual([alone.room, alone.peers, alone.recording, alone.more], [null, [], null, 0]);
});

test('toast heights match the page; toasts stack under the room panel, or alone', () => {
  assert.equal(toastHeight(sanitizeOverlay(room({ toasts: [knock()] })).toasts[0]), 16 + 18 + 16 + 30);
  assert.equal(toastHeight({ kind: 'info', title: 'Вам не разрешили войти', sub: '', actions: [] }), 16 + 34);
  const panel = overlayBounds(sanitizeOverlay(room()), AREA).height;
  assert.equal(overlayBounds(sanitizeOverlay(room({ toasts: [knock(), knock({ id: 'b' })] })), AREA).height, panel + 2 * (6 + 80));
  assert.equal(overlayBounds(sanitizeOverlay(room({ room: null, toasts: [knock()] })), AREA).height, 80);
  // Своё место — от угла рабочей области, но не за краем экрана.
  const custom = overlayBounds(sanitizeOverlay(room({ corner: 'custom', position: { x: 300, y: 2000 } })), AREA);
  assert.deepEqual([custom.x, custom.y + custom.height], [300, 25 + 875]);
  assert.equal(sanitizeOverlay(room({ corner: 'custom' })).corner, 'top-left');
});

test('toasts alone show the overlay when Quazar is away, without grabbing global keys', () => {
  const { overlay, main, keys } = setup({ focused: true });
  overlay.update(room({ room: null, toasts: [knock()] }));
  assert.equal(FakeWindow.created.length, 0);
  main.focused = false; overlay.refresh();
  assert.equal(FakeWindow.created[0].visible, true);
  assert.equal(keys.size, 0);
  overlay.update(room({ room: null, toasts: [] }));
  assert.equal(FakeWindow.created[0].visible, false);
});

test('buttons: clicks pass through except over a button; only buttons on screen reach Quazar', () => {
  const { overlay, actions } = setup();
  overlay.update(room({ toasts: [knock()] }));
  const win = FakeWindow.created[0];
  assert.deepEqual([win.ignore, win.forward], [true, true]);
  overlay.hover(true); assert.equal(win.ignore, false);
  overlay.hover(false); assert.deepEqual([win.ignore, win.forward], [true, true]);
  overlay.action('knock:k1', 'admit');
  overlay.action('knock:k1', 'delete-star');
  overlay.action('knock:other', 'admit');
  assert.deepEqual(actions, [{ toast: 'knock:k1', action: 'admit' }]);
  assert.equal(overlay.fromOverlay({ sender: win.webContents }), true);
  assert.equal(overlay.fromOverlay({ sender: {} }), false);
});

test('«Переставить»: visible over Quazar, draggable, remembers the spot on the monitor it lands on', () => {
  const { overlay, main, moved, placing, timers, actions } = setup({ focused: true });
  overlay.update(null);
  overlay.place(true);
  const win = FakeWindow.created[0];
  assert.deepEqual([win.visible, win.ignore, win.movable, placing], [true, false, true, [true]]);
  // Не в комнате — пример, чтобы было за что тянуть.
  assert.equal(overlay.view().room, 'Оверлей Quazar');
  assert.equal(overlay.view().placing, true);
  overlay.hover(false); assert.equal(win.ignore, false);
  win.bounds = { x: 1440 + 500, y: 120, width: 240, height: 100 };
  win.events.moved();
  assert.deepEqual(moved, [{ display: SECOND.id, x: 500, y: 120 }]);
  overlay.update(room({ display: SECOND.id, corner: 'custom', position: { x: 500, y: 120 } }));
  assert.deepEqual([win.bounds.x, win.bounds.y], [1940, 120]);
  overlay.action('placing', 'done');
  assert.deepEqual([win.ignore, win.movable, placing, win.visible], [true, false, [true, false], false]);
  assert.deepEqual(actions, []);
  // Забыли нажать «Готово» — через две минуты само.
  main.focused = false; overlay.place(true);
  timers[timers.length - 1].fn();
  assert.deepEqual([placing.at(-1), timers[timers.length - 1].ms], [false, 120_000]);
  // Не в режиме перестановки перетаскивание не запоминаем.
  win.events.moved();
  assert.equal(moved.length, 1);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Overlay, sanitizeOverlay, overlayBounds, MAX_PEERS } = require('../src/overlay.cjs');

const AREA = { x: 0, y: 25, width: 1440, height: 875 };
const room = (patch = {}) => ({ enabled: true, globalKeys: true, corner: 'top-left', room: 'Переговорная', reconnecting: false,
  peers: [{ name: 'Анна', speaking: true, micOn: true, isLocal: true }, { name: 'Боб', speaking: false, micOn: false, isLocal: false }], more: 0, ...patch });

class FakeWindow {
  static created = [];
  constructor(options) { this.options = options; this.visible = false; this.calls = []; this.sent = []; this.destroyed = false; this.handlers = {};
    this.webContents = { send: (channel, value) => this.sent.push([channel, value]), setWindowOpenHandler() {}, on: (name, fn) => { this.handlers[name] = fn; } };
    FakeWindow.created.push(this); }
  setAlwaysOnTop(...args) { this.calls.push(['alwaysOnTop', ...args]); }
  setIgnoreMouseEvents(value) { this.calls.push(['ignoreMouse', value]); }
  setContentProtection(value) { this.calls.push(['contentProtection', value]); }
  setVisibleOnAllWorkspaces(...args) { this.calls.push(['allWorkspaces', ...args]); }
  setBounds(bounds) { this.bounds = bounds; }
  loadFile() { setImmediate(() => this.handlers['did-finish-load']?.()); return Promise.resolve(); }
  on() {}
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  showInactive() { this.visible = true; this.calls.push(['showInactive']); }
  show() { throw new Error('оверлей не должен забирать фокус'); }
  hide() { this.visible = false; }
  destroy() { this.destroyed = true; }
}
function setup({ focused = false, platform = 'darwin' } = {}) {
  FakeWindow.created = [];
  const main = { focused, isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, isFocused: () => main.focused };
  const keys = new Map();
  const globalShortcut = { register: (acc, fn) => { keys.set(acc, fn); return true; }, unregister: acc => keys.delete(acc), isRegistered: acc => keys.has(acc) };
  const hotkeys = [];
  const overlay = new Overlay({ BrowserWindow: FakeWindow, screen: { getPrimaryDisplay: () => ({ workArea: AREA }) }, globalShortcut,
    getMain: () => main, onHotkey: action => hotkeys.push(action), platform });
  return { overlay, main, keys, hotkeys };
}

test('sanitizes renderer state: bounded strings, booleans and peer count', () => {
  assert.equal(sanitizeOverlay(null), null);
  const peers = Array.from({ length: 40 }, (_, i) => ({ name: `<b>${'x'.repeat(100)}\n${i}`, speaking: 'yes', micOn: 1, deafened: true }));
  const out = sanitizeOverlay({ corner: 'center', room: 42, peers, more: -3, extra: 'file:///etc/passwd' });
  assert.equal(out.peers.length, MAX_PEERS);
  assert.equal(out.peers[0].name.length, 60);
  assert.ok(!out.peers[0].name.includes('\n'));
  assert.deepEqual({ ...out.peers[0], name: '' }, { name: '', speaking: false, micOn: false, isLocal: false, deafened: false });
  assert.deepEqual({ corner: out.corner, room: out.room, more: out.more, enabled: out.enabled, extra: out.extra }, { corner: 'top-left', room: '', more: 0, enabled: true, extra: undefined });
});

test('window sits in the chosen corner and grows with the participants', () => {
  const top = overlayBounds(sanitizeOverlay(room()), AREA);
  assert.deepEqual(top, { x: 16, y: 41, width: 240, height: 18 + 24 + 2 * 28 });
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

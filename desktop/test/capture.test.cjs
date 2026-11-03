const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { installCapture } = require('../src/capture.cjs');

function fixture(getSources = async () => [{ id: 'screen:1', name: 'Screen', thumbnail: { toDataURL: () => 'data:image/png;base64,' } }]) {
  let picker, handler;
  const listeners = {}, handlers = {}, mainFrame = {};
  class Window extends EventEmitter {
    constructor() { super(); picker = this; this.webContents = { mainFrame: {}, setWindowOpenHandler() {}, on() {} }; }
    isDestroyed() { return false; }
    async loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
    close() { this.emit('closed'); }
  }
  const owner = { webContents: { mainFrame }, isDestroyed: () => false };
  installCapture({ session: { setDisplayMediaRequestHandler: value => { handler = value; } }, BrowserWindow: Window,
    desktopCapturer: { getSources }, ipcMain: { on: (name, fn) => { listeners[name] = fn; }, handle: (name, fn) => { handlers[name] = fn; } }, getWindow: () => owner });
  return { request: patch => ({ frame: mainFrame, securityOrigin: 'quazar-app://app', userGesture: true, audioRequested: false, ...patch }),
    run: (...args) => handler(...args), get picker() { return picker; },
    event: () => ({ sender: picker.webContents, senderFrame: picker.webContents.mainFrame }), listeners, handlers };
}
test('capture rejects subframes, foreign origins and missing user gestures before enumerating sources', async () => {
  let enumerated = 0;
  const f = fixture(async () => { enumerated++; return []; });
  for (const patch of [{ frame: {} }, { securityOrigin: 'https://evil.test' }, { userGesture: false }]) {
    let result;
    await f.run(f.request(patch), value => { result = value; });
    assert.deepEqual(result, {});
  }
  assert.equal(enumerated, 0);
});
test('capture starts only after an explicit source selection and cannot add unrequested audio', async () => {
  const f = fixture(); let result;
  await f.run(f.request(), value => { result = value; });
  assert.equal(result, undefined);
  const list = f.handlers['capture:list'](f.event());
  assert.equal(list.sources[0].name, 'Screen');
  f.listeners['capture:select'](f.event(), { id: 'screen:1', audio: true });
  assert.equal(result.video.id, 'screen:1');
  assert.equal(result.audio, undefined);
});
test('closing the picker cancels exactly once and a foreign IPC sender cannot select a screen', async () => {
  const f = fixture(); const results = [];
  await f.run(f.request({ audioRequested: true }), value => results.push(value));
  f.listeners['capture:select']({ sender: {}, senderFrame: {} }, { id: 'screen:1', audio: true });
  assert.equal(results.length, 0);
  f.picker.close();
  assert.deepEqual(results, [{}]);
});
test('a second request cannot race source enumeration and replace the first picker', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  const first = f.run(f.request(), () => {});
  let rejected;
  await f.run(f.request(), value => { rejected = value; });
  assert.deepEqual(rejected, {});
  resolve([]); await first; f.picker.close();
});

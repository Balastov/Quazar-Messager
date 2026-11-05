const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { waitForMainWindow } = require('../src/startup-window.cjs');

function fixture() {
  const window = new EventEmitter();
  window.isDestroyed = () => false;
  let loaded;
  window.loadURL = () => new Promise(resolve => { loaded = resolve; });
  return { window, loaded: () => loaded() };
}
test('waits for both page load and first paint, in either order', async () => {
  for (const paintFirst of [true, false]) {
    const f = fixture(); let ready = false;
    const waiting = waitForMainWindow(f.window, 'quazar-app://app/').then(value => { ready = value; });
    if (paintFirst) f.window.emit('ready-to-show'); else f.loaded();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ready, false);
    if (paintFirst) f.loaded(); else f.window.emit('ready-to-show');
    await waiting; assert.equal(ready, true);
    assert.equal(f.window.listenerCount('ready-to-show'), 0);
    assert.equal(f.window.listenerCount('closed'), 0);
  }
});
test('a page load failure does not wait forever for paint and removes listeners', async () => {
  const f = fixture(); f.window.loadURL = () => Promise.reject(new Error('load failed'));
  await assert.rejects(waitForMainWindow(f.window, 'quazar-app://app/'), /load failed/);
  assert.equal(f.window.listenerCount('ready-to-show'), 0);
  assert.equal(f.window.listenerCount('closed'), 0);
});
test('closing the main window before paint aborts startup', async () => {
  const f = fixture(), waiting = waitForMainWindow(f.window, 'quazar-app://app/');
  f.window.emit('closed');
  await assert.rejects(waiting, /closed during startup/);
  assert.equal(f.window.listenerCount('ready-to-show'), 0);
});

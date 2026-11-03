const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Updates } = require('../src/updates.cjs');
function fixture(platform = 'win32') {
  let installed = 0, opened = null, busy = false, downloads = 0;
  const updater = new EventEmitter(); updater.setFeedURL = value => { updater.feed = value; };
  updater.checkForUpdates = async () => { updater.emit('update-available', { version: '0.20.0' }); };
  updater.downloadUpdate = async () => { downloads++; updater.emit('update-downloaded', { version: '0.20.0' }); };
  const updates = new Updates({ updater, platform, arch: 'arm64', version: '0.19.2', packaged: true, isBusy: () => busy,
    quitAndInstall: () => installed++, openExternal: async value => { opened = value; } });
  return { updater, updates, get installed() { return installed; }, get opened() { return opened; }, get downloads() { return downloads; }, busy: value => { busy = value; } };
}
test('downloads a Windows update but never interrupts an active call or installs on a normal quit', async () => {
  const f = fixture();
  await f.updates.check();
  assert.equal(f.updates.state.status, 'downloaded');
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.equal(f.installed, 0);
  f.busy(true);
  assert.equal((await f.updates.install()).ok, false);
  assert.equal(f.installed, 0);
  f.busy(false);
  assert.equal((await f.updates.install()).ok, true);
  assert.equal(f.installed, 1);
});
test('macOS pilot offers a DMG for its own architecture and never attempts unsigned auto-installation', async () => {
  const f = fixture('darwin');
  await f.updates.check();
  assert.equal(f.downloads, 0);
  assert.equal(f.updates.state.status, 'available');
  await f.updates.install();
  assert.equal(f.opened, 'https://quazar-msg.ru/desktop-updates/mac-arm64/Quazar-0.20.0-mac-arm64.dmg');
  assert.equal(f.installed, 0);
});
test('network failure leaves the installed app usable without running an installer', async () => {
  const f = fixture(); f.updater.checkForUpdates = async () => { throw new Error('network'); };
  await f.updates.check();
  assert.equal(f.updates.state.status, 'error'); assert.equal(f.installed, 0);
});
test('a synchronous update failure can be retried later', async () => {
  const f = fixture();
  f.updater.checkForUpdates = () => { throw new Error('unavailable'); };
  await f.updates.check();
  f.updater.checkForUpdates = async () => f.updater.emit('update-not-available');
  await f.updates.check();
  assert.equal(f.updates.state.status, 'up-to-date');
});
test('parallel update requests share one download', async () => {
  const f = fixture(); await Promise.all([f.updates.check(), f.updates.check(), f.updates.check()]);
  assert.equal(f.downloads, 1);
});
test('a failed package verification is never treated as a downloaded update', async () => {
  const f = fixture(); f.updater.downloadUpdate = async () => { throw new Error('checksum mismatch'); };
  await f.updates.check();
  assert.equal((await f.updates.install()).ok, false); assert.equal(f.installed, 0);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Startup } = require('../src/startup.cjs');
function fixture() {
  let installs = 0, checks = 0;
  const updates = new EventEmitter();
  updates.state = { currentVersion: '0.19.2', status: 'idle', manual: false };
  updates.check = async () => { checks++; return { ...updates.state, status: 'up-to-date' }; };
  updates.install = async () => { installs++; return { ok: true }; };
  return { updates, startup: new Startup(updates), get installs() { return installs; }, get checks() { return checks; } };
}
test('does not open the main application before the startup check has finished', async () => {
  const f = fixture(); let finish;
  f.updates.check = () => new Promise(resolve => { finish = resolve; });
  const running = f.startup.start(); await Promise.resolve();
  assert.equal(f.startup.state.phase, 'checking');
  finish({ status: 'up-to-date' }); await running;
  assert.equal(f.startup.state.phase, 'ready');
});
test('waits for a Windows download and starts the installer without exposing the old main window', async () => {
  const f = fixture(); let finish;
  f.updates.check = () => {
    f.updates.emit('state', { status: 'available', version: '0.20.0' });
    f.updates.emit('state', { status: 'downloading', version: '0.20.0', progress: 14 });
    return new Promise(resolve => { finish = resolve; });
  };
  const running = f.startup.start(); await Promise.resolve();
  assert.equal(f.startup.state.phase, 'downloading'); assert.equal(f.startup.state.progress, 14);
  assert.equal(f.startup.continueWithoutCheck(), false);
  finish({ status: 'downloaded', version: '0.20.0' }); await running;
  assert.equal(f.startup.state.phase, 'installing'); assert.equal(f.installs, 1);
});
test('only an unknown update status permits explicitly continuing after a network error', async () => {
  const f = fixture(); f.updates.check = async () => ({ status: 'error' });
  await f.startup.start();
  assert.equal(f.startup.state.canContinue, true);
  assert.equal(f.startup.continueWithoutCheck(), true);
  assert.equal(f.startup.state.phase, 'ready');
});
test('a known required update cannot be bypassed after a failed download or failed retry', async () => {
  const f = fixture();
  f.updates.check = async () => { f.updates.emit('state', { status: 'available', version: '0.20.0' }); return { status: 'error' }; };
  await f.startup.start();
  assert.equal(f.startup.state.canContinue, false); assert.equal(f.startup.continueWithoutCheck(), false);
  f.updates.check = async () => ({ status: 'error' }); await f.startup.start();
  assert.equal(f.startup.state.canContinue, false); assert.equal(f.startup.continueWithoutCheck(), false);
});
test('Mac pilot opens normally and leaves the available update for manual installation', async () => {
  const f = fixture(); f.updates.check = async () => ({ status: 'available', version: '0.20.0', manual: true });
  await f.startup.start();
  assert.equal(f.startup.state.phase, 'ready'); assert.equal(f.installs, 0);
});
test('an installer failure remains retryable and never opens an out-of-date app', async () => {
  const f = fixture();
  f.updates.check = async () => { f.updates.emit('state', { status: 'downloaded', version: '0.20.0' }); return { status: 'downloaded', version: '0.20.0' }; };
  f.updates.install = async () => ({ ok: false, reason: 'installer failed' });
  await f.startup.start(); assert.equal(f.startup.state.phase, 'error'); assert.equal(f.startup.state.canContinue, false);
  f.updates.install = async () => ({ ok: true });
  await f.startup.start(); assert.equal(f.startup.state.phase, 'installing');
});
test('parallel retry requests share the same startup operation', async () => {
  const f = fixture(); await Promise.all([f.startup.start(), f.startup.start(), f.startup.start()]);
  assert.equal(f.checks, 1);
});
test('a cached update remains mandatory even without a new update event', async () => {
  const f = fixture(); f.updates.check = async () => ({ status: 'downloaded', version: '0.20.0' });
  f.updates.install = async () => ({ ok: false });
  await f.startup.start();
  assert.equal(f.startup.state.phase, 'error'); assert.equal(f.startup.continueWithoutCheck(), false);
});

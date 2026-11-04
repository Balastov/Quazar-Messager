const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DesktopLauncher } = require('../src/launch.cjs');
const { isUpdateLaunch } = require('../src/policy.cjs');

function fixture(state = { status: 'downloaded', version: '0.20.3', manual: false }) {
  let shown = 0, checks = 0, installs = 0, starting = false, refusal = null, notified = null;
  const updates = { state, check: async () => { checks++; return state; }, install: async () => { installs++; return { ok: true }; } };
  const launcher = new DesktopLauncher({ updates, show: () => shown++, isStarting: () => starting,
    onState: value => { notified = value; }, onBlocked: async reason => { refusal = reason; } });
  return { launcher, updates, get shown() { return shown; }, get checks() { return checks; }, get installs() { return installs; },
    get refusal() { return refusal; }, get notified() { return notified; }, starting: value => { starting = value; } };
}

test('web launch accepts only the fixed update route, with no arbitrary URL or OAuth data', () => {
  assert.equal(isUpdateLaunch('quazar-desktop://app/update'), true);
  for (const url of ['https://app/update', 'quazar-desktop://evil/update', 'quazar-desktop://user@app/update',
    'quazar-desktop://app:42/update', 'quazar-desktop://app/update?url=https://evil.test', 'quazar-desktop://app/update#code=x',
    'quazar-desktop://app/update/extra', 'quazar-desktop://auth/yandex#code=x']) assert.equal(isUpdateLaunch(url), false);
});

test('web launch opens a running app and installs its verified Windows update', async () => {
  const f = fixture(); await f.launcher.run();
  assert.equal(f.shown, 1); assert.equal(f.checks, 1); assert.equal(f.installs, 1);
  assert.equal(f.notified.requested, true);
});

test('an active call refusal is displayed without forcing installation', async () => {
  const f = fixture(); f.updates.install = async () => ({ ok: false, reason: 'Сначала завершите звонок' });
  await f.launcher.run();
  assert.equal(f.installs, 0); assert.equal(f.refusal, 'Сначала завершите звонок');
});

test('parallel deep links share the check and installation', async () => {
  const f = fixture(); await Promise.all([f.launcher.run(), f.launcher.run()]);
  assert.equal(f.checks, 1); assert.equal(f.installs, 1);
});

test('a cold launch waits for startup and reuses its completed check', async () => {
  const f = fixture({ status: 'up-to-date', manual: false });
  f.starting(true); await f.launcher.run();
  assert.equal(f.checks, 0); assert.equal(f.installs, 0);
  f.starting(false); await f.launcher.ready();
  assert.equal(f.checks, 0); assert.equal(f.installs, 0);
  assert.equal(f.notified.status, 'up-to-date');
});

test('a Mac deep link uses manual installation, including after a cold startup', async () => {
  const f = fixture({ status: 'available', manual: true, version: '0.20.3' });
  f.starting(true); await f.launcher.run();
  f.starting(false); await f.launcher.ready();
  assert.equal(f.checks, 0); assert.equal(f.installs, 1);
});

test('a failed check cannot start installation', async () => {
  const f = fixture({ status: 'error', manual: false, message: 'offline' });
  await f.launcher.run();
  assert.equal(f.installs, 0); assert.equal(f.refusal, 'offline');
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { APP_URL, requestTarget, isAppUrl, externalUrl, allowedNotification, authUrl, authReturn, updateUrl } = require('../src/policy.cjs');
const { createProtocolHandler } = require('../src/protocol.cjs');

test('navigation and IPC origins cannot be confused with another host or protocol', () => {
  assert.ok(isAppUrl(APP_URL + '/auth'));
  for (const url of ['https://app/', 'quazar-app://app.evil/', 'quazar-app://evil@app/', 'quazar-app://app:42/', 'file:///etc/passwd']) assert.equal(isAppUrl(url), false);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,test', 'https://user:pass@quazar-msg.ru/']) assert.equal(externalUrl(url), null);
  assert.equal(externalUrl('https://example.com/'), 'https://example.com/');
});
test('local file access is contained and API forwarding has a fixed backend', () => {
  const root = path.resolve('/tmp/renderer');
  assert.equal(requestTarget(APP_URL + '/auth/yandex', root).file, path.join(root, 'index.html'));
  assert.equal(requestTarget(APP_URL + '/api/users/me', root).remote, 'https://quazar-msg.ru/api/users/me');
  for (const suffix of ['/%2f..%2fprivate.txt', '/..%2fprivate.txt', '/%5c..%5cprivate.txt', '/%00file']) assert.equal(requestTarget(APP_URL + suffix, root), null);
  assert.equal(requestTarget('https://evil.test/api/users/me', root), null);
});
test('notification click payload carries only bounded app routes', () => {
  const out = allowedNotification({ title: 'Message', body: 'Body', tag: 'x', data: { kind: 'message', chatId: 'chat', url: 'file:///etc/passwd', execute: true } });
  assert.deepEqual(out.data, { kind: 'message', chatId: 'chat' });
  assert.equal(allowedNotification({ title: 42, body: 'x' }), null);
});
test('OAuth opens only the expected entry points and accepts no token-bearing deep links', () => {
  assert.ok(authUrl('https://quazar-msg.ru/api/auth/yandex/start?client=desktop&challenge=' + 'a'.repeat(43)));
  assert.ok(authUrl('https://oauth.yandex.ru/authorize?client_id=x'));
  assert.equal(authUrl('https://evil.test/authorize'), null);
  assert.equal(authUrl('https://quazar-msg.ru/api/auth/yandex/start?client=web'), null);
  assert.equal(authReturn('quazar-desktop://auth/yandex#code=one-time'), '#code=one-time');
  for (const value of ['quazar://auth/yandex#code=x', 'quazar-desktop://auth/yandex-extra#code=x', 'quazar-desktop://auth/yandex#access_token=x', 'quazar-desktop://evil/yandex#code=x']) assert.equal(authReturn(value), null);
  assert.notEqual(updateUrl('darwin', 'arm64'), updateUrl('darwin', 'x64'));
});
test('packaged routes and missing assets never fall back to remote HTML', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quazar-protocol-'));
  try {
    await fs.writeFile(path.join(root, 'index.html'), '<main>local renderer</main>');
    const handle = createProtocolHandler(root, () => { throw new Error('unexpected remote request'); });
    const response = await handle(new Request(APP_URL + '/auth'));
    assert.match(await response.text(), /local renderer/);
    assert.match(response.headers.get('Content-Security-Policy'), /object-src 'none'/);
    assert.equal((await handle(new Request(APP_URL + '/assets/missing.js'))).status, 404);
    assert.equal((await handle(new Request(APP_URL + '/auth', { method: 'POST' }))).status, 405);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('API proxy preserves bearer and request body while removing browser cookies and origin', async () => {
  let sent;
  const handle = createProtocolHandler('/tmp/renderer', async (url, options) => {
    sent = { url, options, body: await new Response(options.body).text() };
    return new Response('ok', { headers: { 'Content-Encoding': 'gzip', 'Set-Cookie': 'secret=x' } });
  });
  const response = await handle(new Request(APP_URL + '/api/chats', { method: 'POST', headers: {
    Authorization: 'Bearer test-token', Cookie: 'browser=private', Origin: APP_URL, 'Content-Type': 'application/json',
  }, body: '{"name":"test"}' }));
  assert.equal(sent.url, 'https://quazar-msg.ru/api/chats');
  assert.equal(sent.options.headers.get('Authorization'), 'Bearer test-token');
  assert.equal(sent.options.headers.get('Cookie'), null);
  assert.equal(sent.options.headers.get('Origin'), null);
  assert.equal(sent.body, '{"name":"test"}');
  assert.equal(response.headers.get('Content-Encoding'), null);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(await response.text(), 'ok');
});
test('API redirects cannot serve external scripts through the privileged app origin', async () => {
  const handle = createProtocolHandler('/tmp/renderer', async () => Response.redirect('https://evil.test/', 302));
  assert.equal((await handle(new Request(APP_URL + '/api/redirect'))).status, 502);
});

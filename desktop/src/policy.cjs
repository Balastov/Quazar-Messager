const path = require('node:path');
const APP_URL = 'quazar-app://app';
const SERVER_ORIGIN = 'https://quazar-msg.ru';
const UPDATE_URL = `${SERVER_ORIGIN}/desktop-updates/`;
function updateUrl(platform, arch) { return `${UPDATE_URL}${platform === 'darwin' ? 'mac' : 'win'}-${arch}/`; }
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' https: data: blob:; media-src 'self' blob:; connect-src 'self' https: wss:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; object-src 'none'";

function isAppUrl(value) {
  try { const u = new URL(value); return u.protocol === 'quazar-app:' && u.hostname === 'app' && !u.port && !u.username && !u.password; }
  catch { return false; }
}
function externalUrl(value) {
  try {
    const u = new URL(value);
    return ['https:', 'http:', 'mailto:', 'tel:'].includes(u.protocol) && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}
function requestTarget(rawUrl, root) {
  if (!isAppUrl(rawUrl)) return null;
  const u = new URL(rawUrl);
  let pathname;
  try { pathname = decodeURIComponent(u.pathname); } catch { return null; }
  if (pathname.includes('\0') || pathname.includes('\\')) return null;
  if (pathname.startsWith('/api/') || pathname.startsWith('/media/')) {
    const remote = new URL(u.pathname + u.search, SERVER_ORIGIN);
    if (remote.origin !== SERVER_ORIGIN) return null;
    return { remote: remote.href };
  }
  const filename = path.resolve(root, '.' + pathname);
  if (!filename.startsWith(path.resolve(root) + path.sep) && filename !== path.resolve(root)) return null;
  return { file: path.extname(pathname) ? filename : path.join(root, 'index.html') };
}
function allowedNotification(value) {
  if (!value || typeof value.title !== 'string' || typeof value.body !== 'string') return null;
  const data = value.data ?? {};
  const route = {};
  for (const key of ['kind', 'chatId', 'starId', 'channelId', 'callId', 'messageId', 'threadId', 'door', 'knockId', 'lobbyChannelId', 'action']) {
    if (typeof data[key] === 'string' && data[key].length <= 128) route[key] = data[key];
  }
  return { title: value.title.slice(0, 160), body: value.body.slice(0, 1000),
    tag: typeof value.tag === 'string' ? value.tag.slice(0, 160) : '', silent: value.silent !== false, data: route };
}
function authUrl(value) {
  try {
    const u = new URL(value);
    if (u.username || u.password || u.protocol !== 'https:') return null;
    if (u.origin === SERVER_ORIGIN && u.pathname === '/api/auth/yandex/start' && u.searchParams.get('client') === 'desktop' && /^[\w-]{43}$/.test(u.searchParams.get('challenge') ?? '')) return u.href;
    if (u.origin === 'https://oauth.yandex.ru' && u.pathname === '/authorize') return u.href;
  } catch { /* invalid */ }
  return null;
}
function authReturn(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'quazar-desktop:' || u.hostname !== 'auth' || u.pathname !== '/yandex' || u.username || u.password || u.port || u.search || u.hash.length > 2048) return null;
    const params = new URLSearchParams(u.hash.slice(1));
    if (![...params.keys()].length || [...params].some(([key, val]) => !['code', 'error', 'linked', 'reauth'].includes(key) || val.length > 256)) return null;
    return '#' + params.toString();
  } catch { return null; }
}
module.exports = { APP_URL, SERVER_ORIGIN, UPDATE_URL, updateUrl, CSP, isAppUrl, externalUrl, requestTarget, allowedNotification, authUrl, authReturn };

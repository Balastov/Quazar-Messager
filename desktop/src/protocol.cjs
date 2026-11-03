const fs = require('node:fs/promises');
const path = require('node:path');
const { CSP, requestTarget } = require('./policy.cjs');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg' };

function createProtocolHandler(root, remoteFetch) {
  return async request => {
    const target = requestTarget(request.url, root);
    if (!target) return new Response('Forbidden', { status: 403 });
    if (target.remote) {
      const headers = new Headers(request.headers);
      for (const key of [...headers.keys()]) {
        if (['host', 'origin', 'referer', 'cookie', 'accept-encoding'].includes(key) || key.startsWith('sec-')) headers.delete(key);
      }
      try {
        const response = await remoteFetch(target.remote, {
          method: request.method, headers, redirect: 'manual',
          ...(!['GET', 'HEAD'].includes(request.method) ? { body: request.body, duplex: 'half' } : {}),
        });
        // API не может перенаправить привилегированное окно на сторонний HTML.
        if ([301, 302, 303, 307, 308].includes(response.status)) return new Response('Redirect not allowed', { status: 502 });
        const out = new Headers(response.headers);
        for (const key of ['set-cookie', 'content-encoding', 'content-length', 'access-control-allow-origin']) out.delete(key);
        out.set('X-Content-Type-Options', 'nosniff');
        return new Response(response.body, { status: response.status, headers: out });
      } catch { return new Response('Сервер недоступен. Проверьте подключение к интернету.', { status: 503 }); }
    }
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('', { status: 405 });
    try {
      const bytes = await fs.readFile(target.file);
      return new Response(request.method === 'HEAD' ? null : bytes, { headers: {
        'Content-Type': TYPES[path.extname(target.file)] ?? 'application/octet-stream',
        'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache',
      } });
    } catch { return new Response('Not found', { status: 404 }); }
  };
}
module.exports = { createProtocolHandler };

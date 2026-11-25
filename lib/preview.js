// Preview proxy: serves a local dev site (localhost:PORT) to your phone on its own port,
// so absolute paths, hot reload and websockets keep working.
const http = require('http');
const net = require('net');

function createPreview({ port, isAuthed, cookieName = 'rpc_preview' }) {
  const targetOf = (req) => {
    const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${cookieName}=(\\d+)`));
    return m ? +m[1] : null;
  };
  const server = http.createServer((req, res) => {
    if (!isAuthed(req)) { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end('Open Remote PC and sign in first.'); }
    const url = new URL(req.url, 'http://x');
    // /__rpc_preview?port=3000&to=/path  -> remember target, then go
    if (url.pathname === '/__rpc_preview') {
      const p = +url.searchParams.get('port');
      if (!(p > 0 && p < 65536)) { res.writeHead(400); return res.end('bad port'); }
      const to = url.searchParams.get('to') || '/';
      res.writeHead(302, { 'Set-Cookie': `${cookieName}=${p}; Path=/; SameSite=Lax; Max-Age=86400`, Location: to.startsWith('/') ? to : '/' });
      return res.end();
    }
    const target = targetOf(req);
    if (!target) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('No site selected. Pick one in Remote PC.'); }
    const headers = { ...req.headers, host: `localhost:${target}` };
    delete headers['x-forwarded-for'];
    if (headers.origin) headers.origin = `http://localhost:${target}`;
    if (headers.referer) headers.referer = headers.referer.replace(/^https?:\/\/[^/]+/, `http://localhost:${target}`);
    const up = http.request({ host: '127.0.0.1', port: target, method: req.method, path: req.url, headers }, (r) => {
      const h = { ...r.headers };
      if (h.location) h.location = h.location.replace(new RegExp(`^https?://(localhost|127\\.0\\.0\\.1):${target}`), '');
      res.writeHead(r.statusCode, h);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/html' }); res.end(`<meta name=viewport content="width=device-width"><body style="font:16px -apple-system,sans-serif;padding:40px;color:#888;text-align:center">Nothing is running on localhost:${target} right now.</body>`); } });
    req.pipe(up);
  });
  // websockets (hot reload etc.)
  server.on('upgrade', (req, socket, head) => {
    const target = targetOf(req);
    if (!isAuthed(req) || !target) return socket.destroy();
    const up = net.connect(target, '127.0.0.1', () => {
      const h = { ...req.headers, host: `localhost:${target}` };
      if (h.origin) h.origin = `http://localhost:${target}`;
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  });
  server.listen(port, '0.0.0.0');
  return server;
}

module.exports = { createPreview };

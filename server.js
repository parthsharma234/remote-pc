const express = require('express');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const agents = require('./lib/agents');
const workspace = require('./lib/workspace');
const apps = require('./lib/apps');
const { createPreview } = require('./lib/preview');
const { createPush } = require('./lib/push');

// ---------- config (token lives outside the repo) ----------
const DATA_DIR = path.join(os.homedir(), '.remote-pc');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
const defaults = { port: 7420, previewPort: 7421, host: '0.0.0.0', token: crypto.randomBytes(24).toString('base64url') };
let config = defaults;
try { config = { ...defaults, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch {}
fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
if (process.env.RPC_PORT) config.port = +process.env.RPC_PORT; // testing override, not saved
if (process.env.RPC_PREVIEW_PORT) config.previewPort = +process.env.RPC_PREVIEW_PORT;


// ---------- auth ----------
const COOKIE = 'rpc_auth';
const tokenOk = (t) => {
  if (typeof t !== 'string') return false;
  const a = Buffer.from(t), b = Buffer.from(config.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const cookieToken = (req) => {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
};
const isAuthed = (req) => tokenOk(cookieToken(req)) || tokenOk(req.headers['x-rpc-token']);
const failures = new Map();
const blocked = (ip) => { const f = failures.get(ip); return f && f.n >= 8 && Date.now() < f.until; };
const fail = (ip) => { const f = failures.get(ip) || { n: 0 }; f.n++; f.until = Date.now() + 10 * 60 * 1000; failures.set(ip, f); };
const isHttps = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';
// SameSite=Lax so the preview port (same host, different port) gets it too
const setCookie = (req, res) => res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(config.token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${isHttps(req) ? '; Secure' : ''}`);

function addresses() {
  const ifaces = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => list.filter((i) => i.family === 'IPv4' && !i.internal).map((i) => ({ name, ip: i.address })));
  const rank = ({ name, ip }) => (ip.startsWith('100.') ? 0 : /vEthernet|WSL|Hyper-V|VPN|Proton|TUN|TAP|VirtualBox|VMware|Loopback/i.test(name) ? 3 : /Wi-?Fi|WLAN|Ethernet/i.test(name) ? 1 : 2);
  const ips = ifaces.sort((a, b) => rank(a) - rank(b)).map((i) => i.ip);
  return { ips, ts: ips.find((ip) => ip.startsWith('100.')) };
}
// if Tailscale Serve is forwarding HTTPS to us, use that address (needed for smooth video)
const { execFile } = require('child_process');
const TS = 'C:\\Program Files\\Tailscale\\tailscale.exe';
function tailscaleHttps() {
  return new Promise((resolve) => {
    if (!fs.existsSync(TS)) return resolve(null);
    execFile(TS, ['serve', 'status', '--json'], { timeout: 4000, windowsHide: true }, (err, out) => {
      if (err || !out || !out.includes(`:${config.port}`)) return resolve(null);
      execFile(TS, ['status', '--json'], { timeout: 4000, windowsHide: true }, (e2, s) => {
        try { resolve(JSON.parse(s).Self.DNSName.replace(/\.$/, '')); } catch { resolve(null); }
      });
    });
  });
}
// Really on this PC: loopback *and* not forwarded (Tailscale Serve also connects from 127.0.0.1, but adds these headers)
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) &&
  !req.headers['x-forwarded-for'] && !req.headers['tailscale-user-login'] && !req.headers['x-forwarded-host'];

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback'); // tailscale serve proxies from localhost

app.get('/login', (req, res) => {
  if (blocked(req.ip)) return res.status(429).send('Too many attempts');
  if (!tokenOk(req.query.t)) { fail(req.ip); return res.redirect('/'); }
  setCookie(req, res); res.redirect('/');
});
app.post('/api/login', express.json(), (req, res) => {
  if (blocked(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
  if (!tokenOk(req.body && req.body.token)) { fail(req.ip); return res.status(401).json({ error: 'That key didn’t work' }); }
  setCookie(req, res); res.json({ ok: true });
});
// QR code to sign your phone in. Only shown on the PC itself.
app.get('/pair', async (req, res) => {
  if (!isLocal(req)) return res.status(404).end();
  const { ts, ips } = addresses();
  const host = ts || ips[0] || 'localhost';
  const secure = await tailscaleHttps();
  const url = secure ? `https://${secure}/login?t=${config.token}` : `http://${host}:${config.port}/login?t=${config.token}`;
  const svg = await require('qrcode').toString(url, { type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' } });
  res.type('html').send(`<!doctype html><meta name=viewport content="width=device-width"><title>Pair your phone</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f2f2f7;font:17px -apple-system,'Segoe UI',sans-serif;color:#000">
<div style="text-align:center;background:#fff;border-radius:22px;padding:36px 40px;box-shadow:0 10px 40px rgba(0,0,0,.08);max-width:380px">
<h1 style="font-size:26px;margin:0 0 6px">Pair your phone</h1>
<p style="color:#6e6e73;margin:0 0 22px;font-size:15px">${secure ? 'Secure HTTPS address with smooth video. Turn on Tailscale on your phone, then scan.' : ts ? 'Turn on Tailscale on your phone, then scan with the Camera app.' : 'Your phone must be on the same Wi-Fi. Set up Tailscale to use it anywhere.'}</p>
<div style="width:260px;margin:0 auto">${svg}</div>
<p style="color:#6e6e73;font-size:13px;margin:20px 0 0">Then tap Share → Add to Home Screen.<br>Keep this code private: it signs in to your PC.</p></div></body>`);
});
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.use('/api', (req, res, next) => (isAuthed(req) ? next() : res.status(401).json({ error: 'auth' })));
const json = express.json({ limit: '1mb' });
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));

// ---------- API ----------
app.get('/api/info', (req, res) => {
  // preview lives on its own port; over Tailscale HTTPS it's served on :8443
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').replace(/:\d+$/, '');
  const preview = isHttps(req) ? `https://${host}:8443` : `http://${host}:${config.previewPort}`;
  res.json({ host: os.hostname(), agents: agents.available, preview, projects: agents.projects() });
});

app.get('/api/agents', wrap((req, res) => res.json(agents.list())));
app.get('/api/agents/:id', wrap((req, res) => {
  const d = agents.detail(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (req.query.v && req.query.v === d.version) return res.json({ same: true, status: d.status, running: d.running });
  res.json(d);
}));
app.post('/api/agents', json, wrap((req, res) => {
  const { tool, cwd, prompt, full } = req.body || {};
  res.json({ id: agents.create(tool === 'codex' ? 'codex' : 'claude', String(cwd || '').trim(), String(prompt || ''), { full: !!full }) });
}));
app.post('/api/agents/:id/send', json, wrap(async (req, res) => res.json(await agents.send(req.params.id, String(req.body.prompt || ''), { full: !!req.body.full }))));
app.post('/api/agents/:id/stop', wrap(async (req, res) => { await agents.stop(req.params.id); res.json({ ok: true }); }));

app.get('/api/agents/:id/changes', wrap(async (req, res) => {
  const d = agents.detail(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json(await workspace.changes(d.cwd));
}));
app.get('/api/agents/:id/diff', wrap(async (req, res) => {
  const d = agents.detail(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.type('text/plain').send(await workspace.diff(d.cwd, String(req.query.file || '')));
}));
app.get('/api/apps', wrap(async (req, res) => res.json(await apps.list())));
app.post('/api/apps/:key/launch', wrap(async (req, res) => res.json({ id: await apps.launch(req.params.key) })));
app.post('/api/windows/:id/close', wrap(async (req, res) => { await apps.close(req.params.id); res.json({ ok: true }); }));
// notifications
const push = createPush({ dataDir: DATA_DIR, config, saveConfig: () => { fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')), vapid: config.vapid }, null, 2)); }, agents });
app.get('/api/push', (req, res) => res.json({ key: push.publicKey, on: req.query.endpoint ? push.has(String(req.query.endpoint)) : false }));
app.post('/api/push/subscribe', json, wrap(async (req, res) => { push.subscribe(req.body); await push.test(); res.json({ ok: true }); }));
app.post('/api/push/unsubscribe', json, wrap((req, res) => { push.unsubscribe(String(req.body.endpoint || '')); res.json({ ok: true }); }));
app.post('/api/push/test', wrap(async (req, res) => { await push.test(); res.json({ ok: true }); }));
app.get('/api/sites', wrap(async (req, res) => res.json(await workspace.sites([config.port, config.previewPort, 7420, 7421]))));

// ---------- websockets ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const origin = req.headers.origin || '';
  const deny = () => { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); };
  if (url.pathname === '/ws/app') {
    let sameOrigin = !origin;
    try { if (origin) sameOrigin = new URL(origin).host === (req.headers['x-forwarded-host'] || req.headers.host); } catch {}
    if (!tokenOk(cookieToken(req)) || !sameOrigin) return deny();
    const opts = { w: +url.searchParams.get('w') || 390, h: +url.searchParams.get('h') || 760, fit: url.searchParams.get('fit') !== '0', codec: url.searchParams.get('codec') };
    return wss.handleUpgrade(req, socket, head, (ws) => apps.attach(ws, url.searchParams.get('id'), opts).catch((e) => { try { ws.send(JSON.stringify({ t: 'error', error: e.message })); ws.close(); } catch {} }));
  }
  deny();
});

// ---------- start ----------
server.listen(config.port, config.host, () => {
  createPreview({ port: config.previewPort, isAuthed: (req) => tokenOk(cookieToken(req)) });
  const { ips, ts } = addresses();
  apps.start();
  console.log(`\n  Remote PC is running\n`);
  console.log(`  This PC:  http://localhost:${config.port}`);
  ips.slice(0, 2).forEach((ip) => console.log(`  ${ip === ts ? 'Tailscale' : 'Wi-Fi    '}: http://${ip}:${config.port}`));
  console.log(`  Claude Code: ${agents.available.claude ? 'found' : 'not found'}   Codex: ${agents.available.codex ? 'found' : 'not found'}`);
  console.log(`\n  Access key: ${config.token}\n`);
  const target = ts || ips[0];
  if (target) {
    console.log(`  Scan with your phone to sign in${ts ? '' : ' (same Wi-Fi until Tailscale is set up)'}:\n`);
    require('qrcode-terminal').generate(`http://${target}:${config.port}/login?t=${config.token}`, { small: true });
  }
  console.log(`  Or open http://localhost:${config.port}/pair on this PC for a bigger code.\n`);
});

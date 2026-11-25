// Apps: list your desktop apps, show one window on the phone (resized to a phone shape),
// and send taps / scrolls / typing to it.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------- helper processes ----------
// Two of them so a slow app-list refresh never delays a tap.
class Helper {
  constructor() { this.proc = null; this.queue = []; this.cur = null; this.buf = ''; }
  start() {
    if (this.proc) return;
    this.proc = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'win.ps1')], { windowsHide: true });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => {
      this.buf += d; let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, ''); this.buf = this.buf.slice(i + 1);
        const c = this.cur; if (!c) continue; this.cur = null;
        line.startsWith('err ') ? c.reject(new Error(line.slice(4))) : c.resolve(line);
        this.pump();
      }
    });
    this.proc.on('exit', () => { [this.cur, ...this.queue].filter(Boolean).forEach((q) => q.reject(new Error('helper restarted'))); this.proc = null; this.cur = null; this.queue = []; this.buf = ''; });
  }
  send(cmd) { this.start(); return new Promise((resolve, reject) => { this.queue.push({ cmd, resolve, reject }); this.pump(); }); }
  pump() { if (this.cur || !this.queue.length || !this.proc) return; this.cur = this.queue.shift(); this.proc.stdin.write(this.cur.cmd + '\n'); }
  async json(cmd) { const l = await this.send(cmd); return JSON.parse(l.slice(5)); }
}
const query = new Helper();   // window lists, rects, launching
const input = new Helper();   // clicks, scrolls, typing, moving windows
const uia = new Helper();     // finds text boxes (can be slow on big pages, so it gets its own lane)
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const hwnd = (id) => { if (!/^\d+$/.test(String(id))) throw new Error('bad window'); return String(id); };

// ---------- ffmpeg + encoder ----------
function findFfmpeg() {
  const r = spawnSync('where', ['ffmpeg'], { encoding: 'utf8' });
  if (r.status === 0) return r.stdout.split(/\r?\n/)[0].trim();
  const pkgs = path.join(process.env.LOCALAPPDATA || '', 'Microsoft/WinGet/Packages');
  try {
    for (const d of fs.readdirSync(pkgs).filter((x) => /ffmpeg/i.test(x))) {
      const stack = [path.join(pkgs, d)];
      while (stack.length) { const cur = stack.pop(); for (const e of fs.readdirSync(cur, { withFileTypes: true })) { const p = path.join(cur, e.name); if (e.isDirectory()) stack.push(p); else if (e.name.toLowerCase() === 'ffmpeg.exe') return p; } }
    }
  } catch {}
  return null;
}
const FFMPEG = findFfmpeg();
const ENCODERS = [
  { name: 'h264_nvenc', args: ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-zerolatency', '1', '-rc', 'cbr', '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '600k', '-profile:v', 'main', '-pix_fmt', 'yuv420p'] },
  { name: 'h264_qsv', args: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', '2500k', '-low_delay_brc', '1', '-async_depth', '1', '-profile:v', 'main'], fmt: 'nv12' },
  { name: 'libx264', args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-b:v', '2500k', '-maxrate', '2500k', '-bufsize', '1000k', '-profile:v', 'main', '-pix_fmt', 'yuv420p'] },
];
let encoder;
function getEncoder() {
  if (encoder !== undefined) return encoder;
  encoder = null;
  for (const e of ENCODERS) {
    const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'ddagrab=output_idx=0:framerate=10:video_size=320x240', '-frames:v', '2', '-vf', `hwdownload,format=bgra${e.fmt ? ',format=' + e.fmt : ''}`, ...e.args, '-f', 'null', '-'], { timeout: 15000, windowsHide: true });
    if (r.status === 0) { encoder = e; break; }
  }
  console.log(`  Window video: ${encoder ? encoder.name : 'images only (no H.264 encoder)'}`);
  return encoder;
}

// ---------- the apps you care about ----------
const PINNED = [
  { key: 'chatgpt', name: 'ChatGPT', exe: /^(chatgpt|codex)$/i, start: /^ChatGPT$/ },
  { key: 'claude', name: 'Claude', exe: /^claude$/i, start: /^Claude$/ },
  { key: 'chrome', name: 'Chrome', exe: /^chrome$/i, start: /^Google Chrome$/ },
  { key: 'vscode', name: 'VS Code', exe: /^code$/i, start: /^Visual Studio Code$/ },
];
let startApps = null;
async function list() {
  const [wins, sa] = await Promise.all([query.json('windows'), startApps ? Promise.resolve(startApps) : query.json('startapps').catch(() => [])]);
  startApps = sa;
  const used = new Set();
  const pinned = PINNED.map((p) => {
    const w = wins.filter((x) => p.exe.test(x.exe || ''));
    w.forEach((x) => used.add(x.id));
    const s = sa.find((x) => p.start.test(x.name));
    return { key: p.key, name: p.name, windows: w, icon: (w[0] && w[0].icon) || null, launchable: !!s };
  }).filter((p) => p.windows.length || p.launchable);
  const others = wins.filter((x) => !used.has(x.id) && !/^(TextInputHost|ShellExperienceHost|StartMenuExperienceHost)$/i.test(x.exe || ''));
  return { pinned, others };
}
async function launch(key) {
  const p = PINNED.find((x) => x.key === key);
  if (!startApps) startApps = await query.json('startapps').catch(() => []);
  const s = p && startApps.find((x) => p.start.test(x.name));
  if (!s) throw new Error('App not found');
  const before = new Set((await query.json('quick')).map((w) => w.id));
  await query.send(`launch ${b64('shell:AppsFolder\\' + s.id)}`);
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const ws = (await query.json('quick')).filter((x) => p.exe.test(x.exe || ''));
    // a new window, or (single-instance apps) the existing one after a moment
    const w = ws.find((x) => !before.has(x.id)) || (i > 8 && ws[0]);
    if (w) return w.id;
  }
  throw new Error(`${p.name} didn’t open`);
}

// ---------- viewing one window ----------
const SOI = Buffer.from([0xff, 0xd8]), EOI = Buffer.from([0xff, 0xd9]), AUD = Buffer.from([0, 0, 0, 1, 9]);
const views = new Map(); // hwnd -> view

function nalTypes(au) {
  const out = [];
  for (let i = 0; i + 4 < au.length; i++) if (au[i] === 0 && au[i + 1] === 0 && (au[i + 2] === 1 || (au[i + 2] === 0 && au[i + 3] === 1))) { const s = au[i + 2] === 1 ? i + 3 : i + 4; out.push(au[s] & 0x1f); i = s; }
  return out;
}

async function fitRect(id, phoneW, phoneH, browser) {
  const scr = await query.json('screen');
  const aspect = Math.min(0.75, Math.max(0.35, phoneW / phoneH));
  const h = Math.round(Math.min(scr.wh - 16, 1100));
  let w = Math.max(360, Math.round(h * aspect));
  const place = (ww) => input.send(`place ${id} ${scr.wx + scr.ww - ww - 12} ${scr.wy + 8} ${ww} ${h}`);
  await place(w);
  await keepOnScreen();
  if (!browser) return;
  // Browsers: only the web page is shown on the phone (Chrome's own tabs and address bar are
  // replaced by phone controls), so size the window so the *page* has the phone's shape.
  // That narrow page also makes sites switch to their mobile layout.
  const [r, pg] = await Promise.all([query.json(`rect ${id}`), query.json(`page ${id}`)]);
  if (!r || !pg) return;
  // Chrome's tab strip + address bar aren't needed on the PC screen while you browse from the phone,
  // so tuck them above the top edge: the page gets the full screen height (and a phone-like shape,
  // since Chrome won't go narrower than ~500px).
  const top = pg.y - r.y, bottom = r.y + r.h - (pg.y + pg.h);
  const pageH = scr.wh - 8 - bottom;
  const target = Math.max(360, Math.round(pageH * aspect) + (r.w - pg.w));
  await input.send(`place ${id} ${scr.wx + scr.ww - target - 12} ${scr.wy + 4 - top} ${target} ${pageH + top + bottom}`);
  await keepOnScreen(true);
  // apps have a minimum width; if one stayed wider than asked, slide it back so nothing hangs off the screen
  async function keepOnScreen(keepY) {
    const r = await query.json(`rect ${id}`).catch(() => null);
    if (r && r.x + r.w > scr.wx + scr.ww) await input.send(`place ${id} ${Math.max(scr.wx, scr.wx + scr.ww - r.w - 12)} ${keepY ? r.y : scr.wy + 8} ${r.w} ${keepY ? r.h : h}`);
  }
}

function stopCapture(v) { if (v.ff) { v.ff.removeAllListeners('exit'); v.ff.kill(); v.ff = null; } clearTimeout(v.flushT); }

function startCapture(v) {
  stopCapture(v);
  const r = v.cap || v.rect;
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  const w = Math.min(r.w - (x - r.x), v.screen.w - x) & ~1, h = Math.min(r.h - (y - r.y), v.screen.h - y) & ~1;
  if (w < 32 || h < 32) return;
  v.crop = { x, y, w, h };
  v.gop = []; v.lastJpeg = null;
  const grab = ['-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer', '-f', 'lavfi', '-i', `ddagrab=output_idx=0:framerate=30:draw_mouse=0:dup_frames=0:offset_x=${x}:offset_y=${y}:video_size=${w}x${h}`];
  const enc = v.kind === 'h264' && getEncoder();
  if (v.kind === 'h264' && !enc) v.kind = 'mjpeg';
  const args = v.kind === 'h264'
    ? [...grab, '-vf', `hwdownload,format=bgra${enc.fmt ? ',format=' + enc.fmt : ''}`, ...enc.args, '-g', '60', '-bf', '0', '-fps_mode', 'passthrough', '-bsf:v', 'h264_metadata=aud=insert', '-flush_packets', '1', '-f', 'h264', '-']
    : [...grab, '-vf', 'hwdownload,format=bgra,format=yuvj420p', '-c:v', 'mjpeg', '-q:v', '7', '-fps_mode', 'passthrough', '-flush_packets', '1', '-f', 'mjpeg', '-'];
  const ff = spawn(FFMPEG, args, { windowsHide: true });
  v.ff = ff; let buf = Buffer.alloc(0);
  ff.stdout.on('data', (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    if (v.kind === 'h264') {
      let from = 0, i;
      while ((i = buf.indexOf(AUD, from + 1)) > 0) { onAU(v, Buffer.from(buf.subarray(from, i))); from = i; }
      if (from) buf = Buffer.from(buf.subarray(from));
      // the screen may go still after this frame: don't sit on it waiting for the next one
      clearTimeout(v.flushT);
      v.flushT = setTimeout(() => { if (buf.length) { const au = buf; buf = Buffer.alloc(0); onAU(v, au); } }, 10);
    } else {
      let s, e;
      while ((s = buf.indexOf(SOI)) >= 0 && (e = buf.indexOf(EOI, s + 2)) > 0) { onJpeg(v, Buffer.from(buf.subarray(s, e + 2))); buf = buf.subarray(e + 2); }
      if (buf.length > 6e6) buf = Buffer.alloc(0);
    }
  });
  ff.on('exit', () => { if (v.ff === ff && v.viewers.size) setTimeout(() => v.viewers.size && v.ff === ff && startCapture(v), 800); });
}

function onAU(v, au) {
  const types = nalTypes(au), key = types.includes(5);
  if (types.includes(7)) v.sps = au; // keyframes from nvenc carry SPS/PPS
  if (key) v.gop = [au]; else if (v.gop.length && v.gop.length < 300) v.gop.push(au);
  for (const c of v.viewers) {
    // never let frames queue up on a slow link: skip ahead to the next keyframe instead
    if (c.ws.bufferedAmount > 180e3) { c.needKey = true; continue; }
    if (c.needKey && !key) continue;
    c.needKey = false;
    c.ws.send(au, { binary: true });
  }
}
function onJpeg(v, jpg) {
  v.lastJpeg = jpg;
  // latest frame wins: send only when the phone has shown the previous one
  for (const c of v.viewers) if (c.ready) { c.ready = false; c.ws.send(jpg, { binary: true }); c.sentAt = Date.now(); } else c.pending = true;
}

async function watch(v) {
  let r = await query.json(`rect ${v.id}`).catch(() => null);
  if (!r) { for (const c of v.viewers) c.ws.send(JSON.stringify({ t: 'closed' })); return; }
  if (r.min) {
    // minimized: bring it back and look again right away
    await input.send(`focus ${v.id}`).catch(() => {});
    await new Promise((res) => setTimeout(res, 350));
    r = await query.json(`rect ${v.id}`).catch(() => null);
    if (!r || r.min) return;
  }
  // browsers: capture just the page area (the phone draws its own address bar and tabs)
  const pg = v.browser && v.fitted ? await query.json(`page ${v.id}`).catch(() => null) : null;
  const cap = pg && pg.w > 100 && pg.h > 100 ? pg : r;
  const moved = !v.rect || !v.cap || ['x', 'y', 'w', 'h'].some((k) => Math.abs(r[k] - v.rect[k]) > 2 || Math.abs(cap[k] - v.cap[k]) > 2);
  v.rect = r; v.cap = cap;
  if (moved) { startCapture(v); for (const c of v.viewers) c.ws.send(JSON.stringify({ t: 'size', w: v.crop ? v.crop.w : r.w, h: v.crop ? v.crop.h : r.h, title: r.title, kind: v.kind })); }
}

// ---------- text boxes -> phone keyboard ----------
const norm = (v, b) => { const c = v.crop || v.rect; return { x: (b.x - c.x) / c.w, y: (b.y - c.y) / c.h, w: b.w / c.w, h: b.h / c.h }; };
async function refreshFields(v) {
  if (v.fieldsBusy || !v.rect) return;
  v.fieldsBusy = true;
  try {
    const rects = await uia.json(`fields ${v.id}`);
    const out = rects.map((b) => norm(v, b)).filter((r) => r.x + r.w > 0 && r.y + r.h > 0 && r.x < 1 && r.y < 1);
    const key = JSON.stringify(out.map((r) => [r.x, r.y, r.w, r.h].map((n) => n.toFixed(3))));
    if (key !== v.fieldsKey) { v.fieldsKey = key; for (const c of v.viewers) c.ws.send(JSON.stringify({ t: 'fields', rects: out })); }
  } catch {} finally { v.fieldsBusy = false; }
}
// browser: address + tabs, sent when they change
async function refreshBrowser(v) {
  if (!v.browser || v.browserBusy) return;
  v.browserBusy = true;
  try {
    const b = await uia.json(`chrome ${v.id}`);
    if (!b || !(b.tabs || []).length) return; // hidden for a moment: keep what the phone already shows
    v.tabs = b.tabs;
    const out = { t: 'browser', url: b.url || '', tabs: v.tabs.map((t) => ({ name: t.name, sel: t.sel })) };
    const key = JSON.stringify(out);
    if (key !== v.browserKey) { v.browserKey = key; for (const c of v.viewers) c.ws.send(key); }
  } catch {} finally { v.browserBusy = false; }
}
function soonBrowser(v, ms = 500) { clearTimeout(v.browserT); v.browserT = setTimeout(() => refreshBrowser(v), ms); }
function soonFields(v, ms = 450) { clearTimeout(v.fieldsT); v.fieldsT = setTimeout(() => refreshFields(v), ms); }
async function checkFocus(v, ws) {
  try {
    const f = await uia.json('focused');
    const mine = f.text && v.rect && f.x + f.w > v.rect.x && f.x < v.rect.x + v.rect.w && f.y + f.h > v.rect.y && f.y < v.rect.y + v.rect.h;
    ws.send(JSON.stringify({ t: 'focus', text: !!mine, rect: mine ? norm(v, f) : null }));
  } catch {}
}

async function attach(ws, id, { w, h, fit, codec }) {
  id = hwnd(id);
  if (!FFMPEG) { ws.send(JSON.stringify({ t: 'error', error: 'ffmpeg isn’t installed on the PC (winget install Gyan.FFmpeg)' })); return ws.close(); }
  let v = views.get(id);
  if (!v) {
    const [screen, r] = await Promise.all([query.json('screen'), query.json(`rect ${id}`)]);
    if (!r) { ws.send(JSON.stringify({ t: 'closed' })); return ws.close(); }
    const exe = await query.json(`exe ${id}`).catch(() => '');
    v = { id, viewers: new Set(), screen, saved: { x: r.x, y: r.y, w: r.w, h: r.h, max: r.max }, kind: codec === 'h264' ? 'h264' : 'mjpeg', browser: /^(chrome|msedge|brave)$/i.test(exe) };
    views.set(id, v);
  }
  const c = { ws, ready: true, pending: false, needKey: false };
  v.viewers.add(c);
  ws.send(JSON.stringify({ t: 'mode', browser: v.browser }));
  await input.send(`focus ${id}`).catch(() => {});
  if (fit) { await fitRect(id, w, h, v.browser).catch(() => {}); v.fitted = true; }
  // other windows in front would end up in the video: keep this one on top while it's being viewed
  await input.send(`topmost ${id} 1`).catch(() => {}); v.topmost = true;
  v.rect = null;
  await watch(v);
  if (v.kind === 'h264' && v.gop.length) v.gop.forEach((au) => ws.send(au, { binary: true }));
  else if (v.lastJpeg) { c.ready = false; ws.send(v.lastJpeg, { binary: true }); }
  clearInterval(v.timer);
  v.fieldsKey = null; v.browserKey = null; // make sure the new viewer gets the current state
  v.timer = setInterval(() => { watch(v).catch(() => {}); refreshFields(v); refreshBrowser(v); }, 1500);
  soonFields(v, 600); soonBrowser(v, 300);

  const point = (m) => {
    const cr = v.crop || v.rect;
    return [Math.round(cr.x + Math.min(Math.max(+m.x, 0), 1) * cr.w), Math.round(cr.y + Math.min(Math.max(+m.y, 0), 1) * cr.h)];
  };
  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'ack') { c.ready = true; if (c.pending && v.lastJpeg) { c.pending = false; c.ready = false; ws.send(v.lastJpeg, { binary: true }); } return; }
    try {
      if (!v.rect) return;
      if (m.t === 'tap') { const [x, y] = point(m); await input.send(`click ${id} ${x} ${y} ${m.right ? 'right' : 'left'} ${m.double ? 2 : 1}`); setTimeout(() => checkFocus(v, ws), 180); soonFields(v); soonBrowser(v, 700); }
      else if (m.t === 'wheel') { const [x, y] = point(m); await input.send(`wheel ${x} ${y} ${Math.round(m.delta) | 0}`); soonFields(v, 600); }
      else if (m.t === 'text' && m.text) await input.send(`type ${id} ${b64(String(m.text).slice(0, 4000))}`);
      else if (m.t === 'key' && /^[a-z0-9+]{1,30}$/i.test(m.key || '')) { await input.send(`key ${id} ${m.key}`); if (/enter|tab|esc|alt/.test(m.key)) { setTimeout(() => checkFocus(v, ws), 200); soonFields(v); soonBrowser(v, 600); } }
      else if (m.t === 'fit') { if (m.on) { await fitRect(id, m.w || w, m.h || h, v.browser); v.fitted = true; } else await restore(v); await watch(v); }
      // ---- browser controls ----
      else if (m.t === 'nav' && v.browser && m.url) {
        let u = String(m.url).trim().slice(0, 2000);
        await input.send(`key ${id} ctrl+l`);
        await input.send(`type ${id} ${b64(u)}`);
        await input.send(`key ${id} enter`);
        soonBrowser(v, 400); soonFields(v, 1200);
      }
      else if (m.t === 'tab' && v.browser) {
        const i = m.i | 0, t = (v.tabs || [])[i]; if (!t) return;
        // Ctrl+1..8 picks a tab by position, Ctrl+9 the last one; otherwise click it in the strip
        if (i < 8) await input.send(`key ${id} ctrl+${i + 1}`);
        else if (i === v.tabs.length - 1) await input.send(`key ${id} ctrl+9`);
        else if (t.x != null && t.y >= 0) await input.send(`click ${id} ${t.x} ${t.y} left 1`);
        else return;
        if (m.close) await input.send(`key ${id} ctrl+w`);
        soonBrowser(v, 250); soonFields(v, 800);
      }
      else if (m.t === 'newtab' && v.browser) { await input.send(`key ${id} ctrl+t`); soonBrowser(v, 300); }
    } catch (e) { ws.send(JSON.stringify({ t: 'error', error: e.message })); }
  });
  ws.on('close', () => {
    v.viewers.delete(c);
    if (v.viewers.size) return;
    clearInterval(v.timer); clearTimeout(v.fieldsT); clearTimeout(v.browserT);
    stopCapture(v);
    restore(v).catch(() => {});
    views.delete(id);
  });
}
async function restore(v) {
  if (v.topmost && !v.viewers.size) { v.topmost = false; await input.send(`topmost ${v.id} 0`).catch(() => {}); }
  if (!v.fitted || !v.saved) return;
  v.fitted = false;
  const s = v.saved;
  await input.send(`place ${v.id} ${s.x} ${s.y} ${s.w} ${s.h}`);
  if (s.max) await input.send(`maximize ${v.id}`);
}

module.exports = {
  list, launch, attach,
  close: (id) => input.send(`close ${hwnd(id)}`),
  // warm up (start menu apps + window icons) so the first Apps screen on the phone is instant
  start: () => { query.start(); input.start(); uia.start(); list().catch(() => {}); if (FFMPEG) setTimeout(getEncoder, 500); },
  ffmpeg: !!FFMPEG,
};

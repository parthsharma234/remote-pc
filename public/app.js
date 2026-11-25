/* Remote PC — phone app */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, cls = '') => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const buzz = (ms = 10) => { try { navigator.vibrate && navigator.vibrate(ms); } catch {} };
const TOOL = { claude: 'Claude Code', codex: 'Codex' };

let authed = false, info = { projects: [], agents: {} }, agentsCache = [];

async function api(path, opts = {}) {
  const r = await fetch(path, { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: 'no-store' });
  if (r.status === 401) { authed = false; route(); throw new Error('auth'); }
  if (opts.text) { if (!r.ok) throw new Error('Request failed'); return r.text(); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
}
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600); }

// keep layout above the on-screen keyboard
function fitViewport() {
  const h = window.visualViewport ? visualViewport.height : innerHeight;
  document.documentElement.style.setProperty('--app-h', h + 'px');
  document.body.classList.toggle('kb-open', innerHeight - h > 120);
  window.scrollTo(0, 0);
}
(window.visualViewport || window).addEventListener('resize', fitViewport);
fitViewport();

function when(t) {
  const d = new Date(t), now = new Date();
  const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400e3);
  if (days === 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' });
}

// ---------- sheets ----------
function openSheet(id) { $(id).classList.remove('hidden'); }
function closeSheets() { $$('.sheet').forEach((s) => s.classList.add('hidden')); }
$$('[data-close]').forEach((el) => el.addEventListener('click', closeSheets));
// a glass menu that pops out of the button that opened it (iOS-style)
function actionSheet(title, options, anchor) {
  const m = $('#actions-list');
  m.innerHTML = (title ? `<div class="m-title">${esc(title)}</div>` : '') + options.map((o, i) => o.sep ? '<hr>' : `<button data-i="${i}" class="${o.danger ? 'danger' : ''}"><span>${esc(o.label)}</span>${o.icon ? icon(o.icon) : ''}</button>`).join('');
  $$('#actions-list button').forEach((b) => b.addEventListener('click', () => { closeSheets(); options[b.dataset.i].run(); }));
  openSheet('#sheet-actions');
  const r = anchor ? anchor.getBoundingClientRect() : { left: innerWidth / 2, right: innerWidth / 2, top: innerHeight, bottom: innerHeight, width: 0 };
  const below = r.top < innerHeight / 2, right = r.left + r.width / 2 > innerWidth / 2;
  Object.assign(m.style, { left: right ? 'auto' : Math.max(12, r.left) + 'px', right: right ? Math.max(12, innerWidth - r.right) + 'px' : 'auto', top: below ? r.bottom + 8 + 'px' : 'auto', bottom: below ? 'auto' : innerHeight - r.top + 8 + 'px' });
  m.style.setProperty('--ox', right ? '100%' : '0%'); m.style.setProperty('--oy', below ? '0%' : '100%');
}
// large titles: once you scroll, the small title and the blur edge fade in
$$('.view.root .scroll').forEach((sc) => sc.addEventListener('scroll', () => sc.closest('.view').classList.toggle('scrolled', sc.scrollTop > 40), { passive: true }));

// ---------- routing ----------
let view = null;
const leaveHooks = {};
function show(name) {
  if (view && view !== name && leaveHooks[view]) leaveHooks[view]();
  view = name;
  $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'v-' + name));
  $$('.tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === name));
  document.body.classList.toggle('no-tabbar', !['agents', 'apps'].includes(name));
}
function route() {
  closeSheets();
  if (!authed) return show('login');
  const h = location.hash || '#/';
  let m;
  if ((m = h.match(/^#\/a\/(.+)$/))) { show('chat'); openChat(decodeURIComponent(m[1])); }
  else if (h === '#/apps') { show('apps'); openApps(); }
  else if ((m = h.match(/^#\/w\/(\d+)$/))) { show('win'); openWin(m[1]); }
  else { show('agents'); renderAgents(); }
}
addEventListener('hashchange', route);

// ---------- sign in ----------
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-err').textContent = '';
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: $('#login-key').value.trim() }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Couldn’t connect');
    boot();
  } catch (err) { $('#login-err').textContent = err.message; }
});

// =============== AGENTS ===============
async function pollAgents() {
  if (!authed || document.hidden) return;
  try {
    agentsCache = await api('/api/agents');
    const needs = agentsCache.filter((a) => a.status === 'needs').length;
    $('#badge').textContent = needs; $('#badge').classList.toggle('hidden', !needs);
    if (view === 'agents') renderAgents();
  } catch {}
}
setInterval(pollAgents, 3000);

function agentRow(a) {
  const last = a.last ? (a.last.k === 'step' ? a.last.text : a.last.text) : '';
  return `<a class="row agent" href="#/a/${encodeURIComponent(a.id)}">
    ${a.status === 'needs' ? '<i class="dot"></i>' : ''}
    <span class="app-icon ${a.tool}">${icon(a.tool === 'codex' ? 'codex' : 'claude')}${a.status === 'working' ? '<i class="ring"></i>' : ''}</span>
    <span class="grow">
      <div class="a-top"><span class="a-title">${esc(a.title)}</span><span class="a-time ${a.status === 'working' ? 'working' : a.status === 'needs' ? 'needs' : ''}">${a.status === 'working' ? 'Working' : a.status === 'needs' ? 'Your turn' : when(a.updatedAt)}</span></div>
      <div class="a-sub"><b>${esc(a.project || TOOL[a.tool])}</b>${last ? ' · ' + esc(last) : ''}</div>
    </span>
  </a>`;
}
function renderAgents() {
  const groups = [
    ['Needs you', agentsCache.filter((a) => a.status === 'needs')],
    ['Working', agentsCache.filter((a) => a.status === 'working')],
    ['Recent', agentsCache.filter((a) => a.status === 'done' || a.status === 'error')],
  ].filter(([, l]) => l.length);
  $('#agent-groups').innerHTML = groups.length
    ? groups.map(([label, l]) => `<h2 class="section-title">${label}${l.length > 1 ? `<span class="count">${l.length}</span>` : ''}</h2><div class="group">${l.map(agentRow).join('')}</div>`).join('')
    : `<div class="empty"><div class="empty-icon">${icon('chat')}</div><b>No agents yet</b>Conversations from Claude Code and Codex on your PC show up here, including ones you start in VS Code.</div>`;
}

// ---------- chat ----------
let chat = { id: null, version: null, data: null, timer: null, open: new Set(), sites: [], changes: null, sending: false };

function md(text) {
  const parts = String(text).split(/```[^\n]*\n?/);
  return parts.map((p, i) => {
    if (i % 2) return `<pre><code>${esc(p.replace(/\n$/, ''))}</code></pre>`;
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    const out = []; let list = null, para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`); list = null; } };
    for (const line of p.split('\n')) {
      let m;
      if ((m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/))) { flushPara(); (list = list || []).push(m[1]); }
      else if ((m = line.match(/^#{1,6}\s+(.*)/))) { flushPara(); flushList(); out.push(`<h4>${inline(m[1])}</h4>`); }
      else if (!line.trim()) { flushPara(); flushList(); }
      else { flushList(); para.push(line); }
    }
    flushPara(); flushList();
    return out.join('');
  }).join('');
}

function renderChat(d, forceBottom) {
  const sc = $('#chat-scroll');
  const nearBottom = forceBottom || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120;
  $('#chat-title').textContent = d.title || 'Conversation';
  $('#chat-sub').textContent = `${TOOL[d.tool]} · ${d.project || ''}`;
  $('#prompt').placeholder = `Message ${TOOL[d.tool]}`;
  const html = [];
  const items = d.items || [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.k === 'user') html.push(`<div class="msg-user">${esc(it.text)}</div>`);
    else if (it.k === 'agent') html.push(`<div class="msg-agent ${it.faint ? 'faint' : ''}">${md(it.text)}</div>`);
    else if (it.k === 'error') html.push(`<div class="msg-error">${esc(it.text)}</div>`);
    else if (it.k === 'step') {
      const run = [];
      while (i < items.length && items[i].k === 'step') run.push(items[i++]);
      i--;
      const key = String(run[0].ts || i), last = run[run.length - 1];
      html.push(`<div class="steps ${chat.open.has(key) ? 'open' : ''}" data-key="${esc(key)}">
        <button class="steps-head">${icon(last.icon || 'gear', 'ic')}<span class="s-last">${run.length > 1 ? `${run.length} steps · ` : ''}${esc(last.text)}</span>${icon('fwd', 'chev')}</button>
        <div class="steps-list">${run.map((s) => `<div class="step">${icon(s.icon || 'gear')}<span>${esc(s.text)}</span></div>`).join('')}</div>
      </div>`);
    }
  }
  if (d.status === 'working') html.push('<div class="typing"><i></i><i></i><i></i></div>');
  $('#chat-items').innerHTML = html.join('') || '<div class="empty">Nothing here yet.</div>';
  if (nearBottom) sc.scrollTop = sc.scrollHeight;

  const working = d.status === 'working';
  $('#stop').classList.toggle('hidden', !(d.running || (d.live && working)));
  $('#prompt').placeholder = d.running ? 'Type to interrupt and redirect…' : d.live && working ? 'Message it. It’ll read it next' : `Message ${TOOL[d.tool]}`;
  $('#composer-status').classList.toggle('hidden', !(d.live || (working && !d.running)));
  $('#composer-status').textContent = d.live ? 'Open in a terminal on your PC. Messages are typed there.' : 'Working on your PC. You can reply when it’s done.';
  syncSend();
}
$('#chat-items').addEventListener('click', (e) => {
  const head = e.target.closest('.steps-head');
  if (head) { const box = head.parentElement; box.classList.toggle('open'); box.classList.contains('open') ? chat.open.add(box.dataset.key) : chat.open.delete(box.dataset.key); return; }
  const a = e.target.closest('a[href]');
  if (a) {
    const m = a.href.match(/^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)(\/[^\s]*)?/);
    if (m) { e.preventDefault(); openPreview(+m[1], m[2] || '/'); }
  }
});

async function loadChat(force) {
  if (!chat.id || view !== 'chat') return;
  const id = chat.id;
  try {
    const d = await api(`/api/agents/${encodeURIComponent(id)}${!force && chat.version ? `?v=${encodeURIComponent(chat.version)}` : ''}`);
    if (chat.id !== id) return;
    if (d.same) return;
    if (d.id && d.id !== id) { chat.id = d.id; history.replaceState(null, '', '#/a/' + encodeURIComponent(d.id)); }
    const wasWorking = chat.data && chat.data.status === 'working';
    const first = !chat.data;
    chat.data = d; chat.version = d.version;
    renderChat(d, first);
    if (first || (wasWorking && d.status !== 'working')) refreshExtras();
    if (wasWorking && d.status !== 'working') buzz(40);
  } catch (e) { if (e.message !== 'auth') toast(e.message); }
}
function openChat(id) {
  if (chat.id !== id) {
    chat = { id, version: null, data: null, timer: null, open: new Set(), sites: [], changes: null };
    $('#chat-items').innerHTML = '';
    $('#chat-title').textContent = ''; $('#chat-sub').textContent = '';
    $('#btn-changes').classList.add('hidden'); $('#btn-preview').classList.add('hidden');
  }
  clearInterval(chat.timer);
  chat.timer = setInterval(() => !document.hidden && loadChat(), 1500);
  loadChat(true);
}
leaveHooks.chat = () => { clearInterval(chat.timer); };
$('#chat-back').addEventListener('click', () => { location.hash = '#/'; });

async function refreshExtras() {
  const id = chat.id;
  if (!id || id.startsWith('n_')) return;
  const [ch, sites] = await Promise.all([api(`/api/agents/${encodeURIComponent(id)}/changes`).catch(() => null), api('/api/sites').catch(() => [])]);
  if (chat.id !== id) return;
  chat.changes = ch;
  const n = ch && ch.git ? ch.files.length : 0;
  $('#btn-changes').classList.toggle('hidden', !(ch && ch.git));
  $('#btn-changes span').textContent = n ? n : '';
  // sites the agent mentioned first, then anything else running
  const mentioned = new Set();
  for (const it of (chat.data && chat.data.items) || []) for (const m of String(it.text || '').matchAll(/(?:localhost|127\.0\.0\.1):(\d{2,5})/g)) mentioned.add(+m[1]);
  const running = new Map(sites.map((s) => [s.port, s]));
  chat.sites = [...[...mentioned].filter((p) => running.has(p)), ...sites.map((s) => s.port).filter((p) => !mentioned.has(p))];
  $('#btn-preview').classList.toggle('hidden', !chat.sites.length);
}

// composer
const promptEl = $('#prompt');
function syncSend() {
  promptEl.style.height = 'auto';
  promptEl.style.height = Math.min(150, promptEl.scrollHeight) + 'px';
  // you can interrupt runs started from the phone; desk-started ones you reply to once they finish
  const blocked = chat.data && chat.data.status === 'working' && !chat.data.running && !chat.data.live;
  $('#send').disabled = !promptEl.value.trim() || blocked || chat.sending;
}
promptEl.addEventListener('input', syncSend);
promptEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); $('#composer').requestSubmit(); } });
$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = promptEl.value.trim();
  if (!text || !chat.id || chat.sending) return;
  chat.sending = true; syncSend();
  try {
    const r = await api(`/api/agents/${encodeURIComponent(chat.id)}/send`, { body: { prompt: text } });
    if (r.interrupted) toast('Interrupted. Sending your new message');
    else if (r.live) toast('Sent to your PC');
    if (r.id && r.id !== chat.id) { chat.id = r.id; history.replaceState(null, '', '#/a/' + encodeURIComponent(r.id)); }
    promptEl.value = '';
    // show it right away; the session file catches up in a moment
    chat.data.items = [...chat.data.items.filter((i) => i.k !== 'error'), { k: 'user', text }];
    chat.data.status = 'working'; chat.data.running = !r.live; chat.version = null;
    renderChat(chat.data, true);
    buzz();
  } catch (err) { toast(err.message); }
  chat.sending = false; syncSend();
});
// keep the keyboard up when tapping send
$('#send').addEventListener('touchend', (e) => { if (!$('#send').disabled) { e.preventDefault(); $('#composer').requestSubmit(); } });
$('#stop').addEventListener('click', async () => { try { await api(`/api/agents/${encodeURIComponent(chat.id)}/stop`, { method: 'POST' }); toast('Stopped'); } catch (e) { toast(e.message); } });

// ---------- changes ----------
function renderChanges() {
  const ch = chat.changes;
  $('#changes-title').textContent = 'Changes';
  $('#diff-back-icon use').setAttribute('href', '#i-x');
  $('#diff-back').dataset.mode = 'list';
  if (!ch || !ch.git) { $('#changes-body').innerHTML = '<div class="empty">This project isn’t a git repository, so changes can’t be shown.</div>'; return; }
  if (!ch.files.length) { $('#changes-body').innerHTML = `<div class="empty"><b>No changes</b>Everything on <code>${esc(ch.branch || 'this branch')}</code> is committed.</div>`; return; }
  const add = ch.files.reduce((s, f) => s + (f.add || 0), 0), del = ch.files.reduce((s, f) => s + (f.del || 0), 0);
  $('#changes-body').innerHTML = `<p class="changes-summary">${ch.files.length} file${ch.files.length > 1 ? 's' : ''} · <span class="add">+${add}</span> <span class="del">−${del}</span>${ch.branch ? ` · ${esc(ch.branch)}` : ''}</p>
    <div class="group">${ch.files.map((f, i) => {
      const parts = f.path.split('/'); const name = parts.pop();
      return `<button class="row file-row" data-i="${i}"><span class="grow"><div class="f1">${esc(name)}${f.status === 'new' ? '<span class="tag-new">NEW</span>' : ''}</div>${parts.length ? `<div class="f2">${esc(parts.join('/'))}</div>` : ''}</span>
        <span class="stat">${f.add != null ? `<span class="add">+${f.add}</span>` : ''} ${f.del ? `<span class="del">−${f.del}</span>` : ''}</span>${icon('fwd', 'chev')}</button>`;
    }).join('')}</div>`;
}
$('#btn-changes').addEventListener('click', async () => {
  openSheet('#sheet-changes');
  renderChanges();
  chat.changes = await api(`/api/agents/${encodeURIComponent(chat.id)}/changes`).catch(() => chat.changes);
  if ($('#diff-back').dataset.mode === 'list') renderChanges();
});
$('#changes-body').addEventListener('click', async (e) => {
  const r = e.target.closest('.file-row'); if (!r) return;
  const f = chat.changes.files[r.dataset.i];
  $('#changes-title').textContent = f.path.split('/').pop();
  $('#diff-back-icon use').setAttribute('href', '#i-back');
  $('#diff-back').dataset.mode = 'diff';
  $('#changes-body').innerHTML = '<div class="empty">Loading…</div>';
  try {
    const text = await api(`/api/agents/${encodeURIComponent(chat.id)}/diff?file=${encodeURIComponent(f.path)}`, { text: true });
    const lines = text.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode)/.test(l));
    $('#changes-body').innerHTML = `<div class="diff">${lines.map((l) => {
      const c = l.startsWith('@@') ? 'd-hunk' : l[0] === '+' ? 'd-add' : l[0] === '-' ? 'd-del' : '';
      const body = c === 'd-hunk' ? l.replace(/^@@[^@]*@@\s?/, '⋯ ') : l.slice(1);
      return `<div class="${c}">${esc(body) || ' '}</div>`;
    }).join('')}</div>`;
  } catch (err) { $('#changes-body').innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
});
$('#diff-back').addEventListener('click', () => { if ($('#diff-back').dataset.mode === 'diff') renderChanges(); else closeSheets(); });

// ---------- preview ----------
function openPreview(port, path = '/') {
  closeSheets();
  $('#preview-url').textContent = `localhost:${port}`;
  $('#preview-frame').src = `${info.preview}/__rpc_preview?port=${port}&to=${encodeURIComponent(path)}`;
  $('#preview').classList.remove('hidden');
}
$('#btn-preview').addEventListener('click', () => {
  if (chat.sites.length === 1) return openPreview(chat.sites[0]);
  actionSheet('Sites running on your PC', chat.sites.map((p) => ({ label: `localhost:${p}`, icon: 'play', run: () => openPreview(p) })), $('#btn-preview'));
});
$('#preview-done').addEventListener('click', () => { $('#preview').classList.add('hidden'); $('#preview-frame').src = 'about:blank'; });
$('#preview-reload').addEventListener('click', () => { const f = $('#preview-frame'); try { f.contentWindow.location.reload(); } catch { f.src = f.src; } });

// ---------- new agent ----------
let newTool = 'claude', newProject = null;
$('#new-agent').addEventListener('click', async () => {
  $('#new-err').textContent = ''; $('#new-prompt').value = ''; $('#new-cwd').value = '';
  try { info = { ...info, ...(await api('/api/info')) }; } catch {}
  newProject = info.projects[0] ? info.projects[0].path : null;
  renderProjects();
  openSheet('#sheet-new');
  setTimeout(() => $('#new-prompt').focus(), 350);
});
function renderProjects() {
  $('#new-projects').innerHTML = info.projects.length ? info.projects.map((p) => `<button type="button" class="row ${newProject === p.path && !$('#new-cwd').value ? 'on' : ''}" data-path="${esc(p.path)}"><span class="grow"><div>${esc(p.name)}</div><div class="footnote secondary" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.path)}</div></span>${icon('check', 'check')}</button>`).join('') : '<div class="row secondary">No recent projects</div>';
}
$('#new-projects').addEventListener('click', (e) => { const r = e.target.closest('[data-path]'); if (!r) return; newProject = r.dataset.path; $('#new-cwd').value = ''; renderProjects(); });
$('#new-cwd').addEventListener('input', renderProjects);
$$('#new-tool button').forEach((b) => b.addEventListener('click', () => { newTool = b.dataset.tool; $$('#new-tool button').forEach((x) => x.classList.toggle('on', x === b)); }));
$('#new-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cwd = $('#new-cwd').value.trim() || newProject;
  const prompt = $('#new-prompt').value.trim();
  if (!prompt) return ($('#new-err').textContent = 'Tell it what to do first.');
  if (!cwd) return ($('#new-err').textContent = 'Pick a project folder.');
  $('#new-start').disabled = true;
  try {
    const { id } = await api('/api/agents', { body: { tool: newTool, cwd, prompt, full: $('#new-full').checked } });
    closeSheets();
    location.hash = '#/a/' + encodeURIComponent(id);
  } catch (err) { $('#new-err').textContent = err.message; }
  $('#new-start').disabled = false;
});

// =============== APPS ===============
let appsData = null, appsTimer = null;
const TILE = { chatgpt: 'spark', claude: 'claude', chrome: 'globe', vscode: 'codex' };
$('#app-list').innerHTML = '<div class="empty"><i class="spinner" style="display:inline-block"></i></div>';
async function loadApps() {
  try { appsData = await api('/api/apps'); } catch (e) { if (e.message !== 'auth') $('#app-list').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  if (view !== 'apps') return;
  if (document.querySelector('.app-tile.busy')) return; // don't redraw over an app that's opening
  const img = (src) => (src ? `<img src="${src}" alt="">` : `<span class="noicon">${icon('window')}</span>`);
  // your main apps, home-screen style
  const tiles = appsData.pinned.map((p, i) => {
    const n = p.windows.length, g = TILE[p.key];
    return `<button class="app-tile" data-pin="${i}">
      <span class="tile-icon ${g ? 'glyph ' + p.key : ''}">${g ? icon(g) : p.icon ? `<img src="${p.icon}" alt="">` : icon('window')}${n > 1 ? `<i class="live">${n}</i>` : ''}</span>
      <span class="tile-name">${esc(p.name)}</span><span class="tile-state ${n ? 'open' : ''}">${n ? 'Open' : 'Tap to open'}</span></button>`;
  }).join('');
  const others = appsData.others.map((w) => `<button class="row app-row" data-win="${esc(w.id)}">${img(w.icon)}
    <span class="grow"><div class="t1">${esc(w.exe === 'ApplicationFrameHost' ? w.title : (w.app || w.exe))}</div><div class="t2">${esc(w.exe === 'ApplicationFrameHost' ? '' : w.title)}</div></span>${icon('fwd', 'chev')}</button>`).join('');
  $('#app-list').innerHTML = `<div class="app-grid">${tiles}</div>` +
    (others ? `<h2 class="section-title">Open windows</h2><div class="group">${others}</div>` : '');
}
async function launchApp(tile, p) {
  tile.classList.add('busy'); tile.querySelector('.tile-state').textContent = 'Opening…';
  try { const { id } = await api(`/api/apps/${p.key}/launch`, { method: 'POST' }); location.hash = `#/w/${id}`; }
  catch (err) { toast(err.message); }
  tile.classList.remove('busy');
}
$('#app-list').addEventListener('click', (e) => {
  const r = e.target.closest('[data-win]');
  if (r) return (location.hash = `#/w/${r.dataset.win}`);
  const t = e.target.closest('.app-tile'); if (!t) return;
  const p = appsData.pinned[t.dataset.pin];
  if (!p.windows.length) return launchApp(t, p);
  if (p.windows.length === 1) return (location.hash = `#/w/${p.windows[0].id}`);
  actionSheet(p.name, [...p.windows.map((w) => ({ label: w.title.replace(/ - (Google Chrome|Visual Studio Code)$/, ''), icon: 'window', run: () => (location.hash = `#/w/${w.id}`) })), { sep: true }, { label: 'New window', icon: 'plus', run: () => launchApp(t, p) }], t);
});
$('#apps-refresh').addEventListener('click', loadApps);
function openApps() { loadApps(); clearInterval(appsTimer); appsTimer = setInterval(() => !document.hidden && loadApps(), 5000); }
leaveHooks.apps = () => clearInterval(appsTimer);

// ---------- one window ----------
// H.264 video (decoded by the phone's hardware) when the page is HTTPS; JPEG frames otherwise.
const win = { ws: null, id: null, size: null, fit: true, kind: null };
const wstage = $('#win-stage'), wcanvas = $('#win-canvas'), wctx = wcanvas.getContext('2d', { alpha: false });
const canH264 = window.isSecureContext && typeof VideoDecoder !== 'undefined';
let dec = null, decSps = null, waitKey = true, decTs = 0, pendingFrame = null, rafOn = false, jpegBusy = false, jpegNext = null;

function drawSource(src, w, h) {
  if (wcanvas.width !== w || wcanvas.height !== h) { wcanvas.width = w; wcanvas.height = h; }
  wctx.drawImage(src, 0, 0);
  $('#win-msg').classList.add('hidden');
}
function resetDecoder() { try { dec && dec.state !== 'closed' && dec.close(); } catch {} dec = null; decSps = null; waitKey = true; }
function nals(u8) {
  const out = []; let i = 0, start = -1;
  while (i + 3 <= u8.length) {
    if (u8[i] === 0 && u8[i + 1] === 0 && (u8[i + 2] === 1 || (u8[i + 2] === 0 && u8[i + 3] === 1))) { const sc = u8[i + 2] === 1 ? 3 : 4; if (start >= 0) out.push(u8.subarray(start, i)); start = i + sc; i += sc; }
    else i++;
  }
  if (start >= 0) out.push(u8.subarray(start));
  return out;
}
const hex2 = (b) => b.toString(16).padStart(2, '0');
function onH264(buf) {
  let sps = null, pps = null, key = false; const parts = [];
  for (const n of nals(new Uint8Array(buf))) { const t = n[0] & 31; if (t === 7) sps = n; else if (t === 8) pps = n; else if (t !== 9) { if (t === 5) key = true; parts.push(n); } }
  if (sps && pps && !(decSps && decSps.length === sps.length && decSps.every((x, i) => x === sps[i]))) {
    resetDecoder();
    const desc = new Uint8Array(11 + sps.length + pps.length);
    desc.set([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 0xff]); desc.set(sps, 8);
    desc.set([1, pps.length >> 8, pps.length & 0xff], 8 + sps.length); desc.set(pps, 11 + sps.length);
    dec = new VideoDecoder({
      output: (f) => { if (pendingFrame) pendingFrame.close(); pendingFrame = f; if (!rafOn) { rafOn = true; requestAnimationFrame(() => { rafOn = false; const fr = pendingFrame; pendingFrame = null; if (fr) { drawSource(fr, fr.displayWidth, fr.displayHeight); fr.close(); } }); } },
      error: () => { decSps = null; dec = null; waitKey = true; },
    });
    dec.configure({ codec: `avc1.${hex2(sps[1])}${hex2(sps[2])}${hex2(sps[3])}`, description: desc, optimizeForLatency: true });
    decSps = sps.slice();
  }
  if (!dec || dec.state !== 'configured' || !parts.length || (waitKey && !key)) return;
  waitKey = false;
  let len = 0; for (const n of parts) len += 4 + n.length;
  const data = new Uint8Array(len), dv = new DataView(data.buffer); let o = 0;
  for (const n of parts) { dv.setUint32(o, n.length); data.set(n, o + 4); o += 4 + n.length; }
  try { dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: (decTs++) * 33333, data })); } catch { waitKey = true; }
}
async function onJpeg(buf) {
  if (jpegBusy) { jpegNext = buf; return; }
  jpegBusy = true;
  try { const bmp = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' })); drawSource(bmp, bmp.width, bmp.height); bmp.close && bmp.close(); } catch {}
  jpegBusy = false;
  wsend({ t: 'ack' }); // ready for the next (newest) frame
  if (jpegNext) { const n = jpegNext; jpegNext = null; onJpeg(n); }
}

function openWin(id) {
  if (win.id === id && win.ws && win.ws.readyState <= 1) return;
  closeWin();
  win.id = id; win.size = null; resetDecoder();
  winMsg('Opening…');
  wcanvas.width = 2; wcanvas.height = 2; wcanvas.style.width = '0px';
  const name = appsData && [...appsData.pinned.flatMap((p) => p.windows.map((w) => [w.id, p.name, p.key])), ...appsData.others.map((w) => [w.id, w.app, w.exe])].find(([wid]) => wid === id);
  $('#win-title').textContent = name ? name[1] : '';
  $('#win-sub').textContent = '';
  // know it's a browser before measuring, so the page gets the right shape from the start
  setBrowser(!!name && /^(chrome|msedge)$/i.test(name[2] || ''));
  requestAnimationFrame(() => {
    const w = Math.round(wstage.clientWidth), h = Math.round(wstage.clientHeight);
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/app?id=${id}&w=${w}&h=${h}&fit=${win.fit ? 1 : 0}&codec=${canH264 ? 'h264' : 'mjpeg'}`);
    ws.binaryType = 'arraybuffer';
    win.ws = ws;
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return win.kind === 'h264' ? onH264(e.data) : onJpeg(e.data);
      const m = JSON.parse(e.data);
      if (m.t === 'size') { win.size = { w: m.w, h: m.h }; if (m.kind !== win.kind) { win.kind = m.kind; resetDecoder(); } if (m.title && !$('#win-title').textContent) $('#win-title').textContent = m.title; if (win.browser && m.title) $('#win-sub').textContent = ''; layoutWin(); }
      else if (m.t === 'mode') { if (m.browser !== win.browser) { setBrowser(m.browser); wsend({ t: 'fit', on: win.fit, w: Math.round(wstage.clientWidth), h: Math.round(wstage.clientHeight) }); } }
      else if (m.t === 'browser') onBrowser(m);
      else if (m.t === 'fields') win.fields = m.rects || [];
      else if (m.t === 'focus') onRemoteFocus(m);
      else if (m.t === 'closed') { toast('That window was closed'); location.hash = '#/apps'; }
      else if (m.t === 'error') toast(m.error);
    };
    ws.onclose = () => { if (win.ws === ws && view === 'win') { winMsg('Reconnecting…'); setTimeout(() => { if (win.ws === ws && view === 'win') { win.ws = null; const i = win.id; win.id = null; openWin(i); } }, 1500); } };
  });
}
function closeWin() { if (win.ws) { win.ws.onclose = null; win.ws.close(); } win.ws = null; win.id = null; win.kind = null; win.url = ''; win.tabs = []; win.fields = []; win.focusRect = null; win.kbAuto = false; resetDecoder(); $('#win-type').blur(); $('#win-keys').classList.add('hidden'); $('#type-pill').classList.add('hidden'); }
leaveHooks.win = closeWin;
const wsend = (o) => { if (win.ws && win.ws.readyState === 1) win.ws.send(JSON.stringify(o)); };
// Where the picture sits in the stage. Normally it fits the screen; while you type it fills the
// width and slides up so the text box you're in stays above the keyboard (like iOS does).
win.layout = { k: 1, ox: 0, oy: 0 }; win.fields = []; win.focusRect = null; win.kbAuto = false;
function layoutWin() {
  const W = wstage.clientWidth, H = wstage.clientHeight;
  const iw = (win.size && win.size.w) || wcanvas.width || W, ih = (win.size && win.size.h) || wcanvas.height || H;
  let k = Math.min(W / iw, H / ih), ox = (W - iw * k) / 2, oy = (H - ih * k) / 2;
  if (win.browser) { k = W / iw; ox = 0; oy = 0; if (ih * k > H) { k = H / ih; ox = (W - iw * k) / 2; } } // a web page sits edge to edge, top aligned
  else { k = Math.min((W - 16) / iw, (H - 12) / ih); ox = (W - iw * k) / 2; oy = Math.max(4, (H - ih * k) / 2); } // apps: a little margin, rounded corners
  const typing = document.activeElement === wtype;
  if (typing && win.focusRect) {
    k = W / iw; ox = 0;
    const fieldBottom = (win.focusRect.y + win.focusRect.h) * ih * k, fieldTop = win.focusRect.y * ih * k;
    oy = Math.min(0, H - 14 - fieldBottom);
    if (fieldTop + oy < 8) oy = 8 - fieldTop;                    // tall box: keep its top in view
    oy = Math.max(Math.min(oy, 0), Math.min(0, H - ih * k));
  }
  win.layout = { k, ox, oy };
  Object.assign(wcanvas.style, { width: iw * k + 'px', height: ih * k + 'px', left: ox + 'px', top: oy + 'px' });
}
new ResizeObserver(() => view === 'win' && layoutWin()).observe(wstage);
function toWin(cx, cy) {
  const r = wstage.getBoundingClientRect(), L = win.layout;
  const iw = (win.size && win.size.w) || wcanvas.width || r.width, ih = (win.size && win.size.h) || wcanvas.height || r.height;
  return { x: (cx - r.left - L.ox) / (iw * L.k), y: (cy - r.top - L.oy) / (ih * L.k), k: 1 / L.k };
}
const inField = (p) => win.fields.find((f) => { const mx = 0.02, my = 0.012; return p.x >= f.x - mx && p.x <= f.x + f.w + mx && p.y >= f.y - my && p.y <= f.y + f.h + my; });
function tapDot(cx, cy) { const r = wstage.getBoundingClientRect(), d = document.createElement('div'); d.className = 'tap-dot'; d.style.left = cx - r.left + 'px'; d.style.top = cy - r.top + 'px'; wstage.appendChild(d); setTimeout(() => d.remove(), 450); }

// tap = click, hold = right-click, drag = scroll
let wg = null, wheelAcc = 0, wheelT = null;
wstage.addEventListener('pointerdown', (e) => {
  wstage.setPointerCapture(e.pointerId);
  wg = { sx: e.clientX, sy: e.clientY, ly: e.clientY, t: performance.now(), moved: false, done: false };
  wg.lp = setTimeout(() => { if (wg && !wg.moved) { const p = toWin(wg.sx, wg.sy); wsend({ t: 'tap', x: p.x, y: p.y, right: true }); tapDot(wg.sx, wg.sy); buzz(25); wg.done = true; } }, 550);
});
wstage.addEventListener('pointermove', (e) => {
  if (!wg) return;
  if (!wg.moved && Math.hypot(e.clientX - wg.sx, e.clientY - wg.sy) > 8) { wg.moved = true; clearTimeout(wg.lp); }
  if (wg.moved) {
    const p = toWin(e.clientX, e.clientY);
    wheelAcc += (e.clientY - wg.ly) * p.k * 1.3;
    wg.px = p;
    if (!wheelT) wheelT = setTimeout(() => { wheelT = null; const d = Math.round(wheelAcc); wheelAcc = 0; if (d && wg && wg.px) wsend({ t: 'wheel', x: wg.px.x, y: wg.px.y, delta: d }); }, 40);
  }
  wg.ly = e.clientY;
});
wstage.addEventListener('pointerup', () => {
  if (!wg) return;
  clearTimeout(wg.lp);
  if (!wg.moved && !wg.done && performance.now() - wg.t < 550) {
    const p = toWin(wg.sx, wg.sy);
    if (p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1) {
      wsend({ t: 'tap', x: p.x, y: p.y }); tapDot(wg.sx, wg.sy);
      // iPhones only open the keyboard during the tap itself, so decide right now from the map of text boxes
      const f = inField(p);
      win.lastTap = { at: performance.now(), field: f };
      if (f && !matchMedia('(pointer: coarse)').matches) openKeyboard(true, f);
    }
  }
  wg = null;
});
wstage.addEventListener('touchend', (e) => {
  const t = win.lastTap;
  if (t && t.field && performance.now() - t.at < 400) { e.preventDefault(); openKeyboard(true, t.field); }
  win.lastTap = null;
});
wstage.addEventListener('pointercancel', () => { if (wg) clearTimeout(wg.lp); wg = null; });

function winMsg(text) { $('#win-msg span').textContent = text; $('#win-msg').classList.remove('hidden'); }
$('#win-done').addEventListener('click', () => { location.hash = '#/apps'; });
const refit = () => wsend({ t: 'fit', on: win.fit, w: Math.round(wstage.clientWidth), h: Math.round(wstage.clientHeight) });
$('#win-more').addEventListener('click', (e) => actionSheet(null, [
  ...(win.browser ? [
    { label: 'Forward', icon: 'fwd', run: () => wsend({ t: 'key', key: 'alt+right' }) },
    { label: 'Reload', icon: 'reload', run: () => wsend({ t: 'key', key: 'f5' }) },
    { label: 'New tab', icon: 'plus', run: () => newTab() },
    { sep: true },
  ] : []),
  { label: win.fit ? 'Show at desktop size' : 'Fit to phone', icon: 'window', run: () => { win.fit = !win.fit; refit(); } },
  { label: 'Close window on PC', icon: 'x', danger: true, run: async () => { await api(`/api/windows/${win.id}/close`, { method: 'POST' }).catch((err) => toast(err.message)); location.hash = '#/apps'; } },
], e.currentTarget));

// ---------- browser (Chrome): Safari-style address bar and tabs ----------
win.browser = false; win.tabs = []; win.url = '';
function setBrowser(on) { win.browser = on; $('#v-win').classList.toggle('browser', on); if (on && !win.url) $('#address-text').textContent = 'Loading…'; layoutWin(); }
const cleanTab = (n) => { let s = String(n || ''); for (let i = 0; i < 4; i++) s = s.replace(/ - (Pinned|Audio playing|Muted|Camera.*|Microphone.*|High memory usage.*|Memory usage.*|Network error|Sharing.*|Recording.*)$/i, ''); return s; };
const hostOf = (u) => String(u || '').replace(/^[a-z]+:\/\//i, '').replace(/^www\./, '').split(/[/?#]/)[0];
function onBrowser(m) {
  win.url = m.url || ''; win.tabs = m.tabs || [];
  const host = hostOf(win.url);
  $('#address-text').textContent = host || 'Search or enter website';
  $('#address .lock').classList.toggle('hidden', !host || /^(localhost|127\.|chrome)/.test(host));
  $('#tab-count').textContent = win.tabs.length || 1;
  const cur = win.tabs.find((t) => t.sel);
  if (cur) { $('#win-title').textContent = cleanTab(cur.name).replace(/ - Google Chrome$/, ''); $('#win-sub').textContent = host; }
  if (!$('#sheet-tabs').classList.contains('hidden')) renderTabs();
}
const favColor = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 55% 52%)`; };
function renderTabs() {
  $('#tabs-title').textContent = `${win.tabs.length} Tab${win.tabs.length === 1 ? '' : 's'}`;
  $('#tab-list').innerHTML = win.tabs.map((t, i) => {
    const name = cleanTab(t.name) || 'New Tab';
    return `<div class="tabcard ${t.sel ? 'on' : ''}" data-i="${i}" role="button">
      <span class="fav" style="background:${favColor(name)}">${esc(name.trim()[0] || '·').toUpperCase()}</span>
      <span class="tn">${esc(name)}</span>
      <button class="tclose" data-close-tab="${i}" aria-label="Close tab">${icon('x')}</button></div>`;
  }).join('') || '<div class="empty">No tabs</div>';
}
$('#win-tabs').addEventListener('click', () => { renderTabs(); openSheet('#sheet-tabs'); });
$('#tab-list').addEventListener('click', (e) => {
  const c = e.target.closest('[data-close-tab]');
  if (c) { wsend({ t: 'tab', i: +c.dataset.closeTab, close: true }); c.closest('.tabcard').style.opacity = 0.3; buzz(); return; }
  const card = e.target.closest('.tabcard'); if (!card) return;
  wsend({ t: 'tab', i: +card.dataset.i }); closeSheets(); buzz();
});
$('#win-back').addEventListener('click', () => { wsend({ t: 'key', key: 'alt+left' }); buzz(); });
// address bar: a real phone text box, focused inside the tap so the keyboard opens
function editAddress(initial) {
  openSheet('#sheet-url');
  const i = $('#url-input'); i.value = initial; i.focus(); i.select();
}
$('#address').addEventListener('click', () => editAddress(win.url));
function newTab() { wsend({ t: 'newtab' }); editAddress(''); }
$('#tab-new').addEventListener('click', () => { closeSheets(); newTab(); });
$('#url-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const u = $('#url-input').value.trim(); $('#url-input').blur(); closeSheets();
  if (u) { wsend({ t: 'nav', url: u }); $('#address-text').textContent = hostOf(u) || u; buzz(); }
});
$$('#win-keys [data-key]').forEach((b) => b.addEventListener('touchend', (e) => { e.preventDefault(); wsend({ t: 'key', key: b.dataset.key }); buzz(); }));
$$('#win-keys [data-key]').forEach((b) => b.addEventListener('click', () => wsend({ t: 'key', key: b.dataset.key })));

// typing: a hidden text box catches the phone keyboard; differences become keystrokes
const wtype = $('#win-type'), WSENT = '\u200b\u200b';
let wtypeVal = WSENT;
function openKeyboard(auto, rect) {
  win.kbAuto = auto;
  if (rect) win.focusRect = rect;
  $('#type-pill').classList.add('hidden');
  if (document.activeElement !== wtype) { wtype.value = WSENT; wtypeVal = WSENT; }
  wtype.style.pointerEvents = 'auto';
  wtype.focus({ preventScroll: true });
  $('#win-keys').classList.remove('hidden');
  setTimeout(layoutWin, 60); setTimeout(layoutWin, 350); // after the keyboard animates in
}
function closeKeyboard() { win.kbAuto = false; wtype.blur(); }
// the PC tells us whether a text box really got focus after each tap
function onRemoteFocus(m) {
  const typing = document.activeElement === wtype;
  if (m.text) {
    win.focusRect = m.rect || win.focusRect;
    if (typing) layoutWin();
    else $('#type-pill').classList.remove('hidden'); // keyboard can only open from a tap: offer one
  } else {
    $('#type-pill').classList.add('hidden');
    win.focusRect = null;
    if (typing && win.kbAuto) closeKeyboard();
  }
}
$('#type-pill').addEventListener('touchend', (e) => { e.preventDefault(); openKeyboard(false); });
$('#type-pill').addEventListener('click', () => openKeyboard(false));
$('#win-kbd').addEventListener('click', () => { if (document.activeElement === wtype) closeKeyboard(); else openKeyboard(false); });
wtype.addEventListener('blur', () => { wtype.style.pointerEvents = 'none'; setTimeout(() => { if (document.activeElement !== wtype) { $('#win-keys').classList.add('hidden'); layoutWin(); } }, 200); });
wtype.addEventListener('input', () => {
  const v = wtype.value;
  let i = 0; while (i < v.length && i < wtypeVal.length && v[i] === wtypeVal[i]) i++;
  for (let k = 0; k < wtypeVal.length - i; k++) wsend({ t: 'key', key: 'backspace' });
  const added = v.slice(i).replace(/\u200b/g, '');
  if (added) added.split('\n').forEach((part, idx, arr) => { if (part) wsend({ t: 'text', text: part }); if (idx < arr.length - 1) wsend({ t: 'key', key: 'enter' }); });
  if (v.length > 60 || !v.startsWith(WSENT) || v.includes('\n')) wtype.value = WSENT;
  wtypeVal = wtype.value;
});
// =============== notifications ===============
// Web Push: iPhone needs the Home Screen app (iOS 16.4+) and the HTTPS address.
const push = { reg: null, key: null, on: false };
const standalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
function b64ToBytes(s) { const p = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); }
function paintBell() { const b = $('#notify-btn'); b.classList.toggle('on', push.on); b.querySelector('use').setAttribute('href', push.on ? '#i-bell-on' : '#i-bell'); }
async function initPush() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  try {
    push.reg = await navigator.serviceWorker.register('/sw.js');
    const sub = 'PushManager' in window ? await push.reg.pushManager.getSubscription() : null;
    const r = await api('/api/push' + (sub ? `?endpoint=${encodeURIComponent(sub.endpoint)}` : ''));
    push.key = r.key; push.on = !!(sub && r.on && Notification.permission === 'granted');
    paintBell();
  } catch {}
}
$('#notify-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (!window.isSecureContext) return toast('Notifications need the secure (https) address. See “Use it from anywhere” in the README.');
  if (!('PushManager' in window) || !('Notification' in window)) {
    return toast(isIOS && !standalone() ? 'Add this app to your Home Screen first (Share → Add to Home Screen), then open it from there.' : 'This browser doesn’t support notifications.');
  }
  if (push.on) {
    return actionSheet('Notifications are on', [
      { label: 'Send a test', icon: 'bell', run: () => api('/api/push/test', { method: 'POST' }).then(() => toast('Sent')).catch((err) => toast(err.message)) },
      { label: 'Turn off', icon: 'x', danger: true, run: async () => { const s = await push.reg.pushManager.getSubscription(); if (s) { await api('/api/push/unsubscribe', { body: { endpoint: s.endpoint } }).catch(() => {}); await s.unsubscribe().catch(() => {}); } push.on = false; paintBell(); toast('Notifications off'); } },
    ], btn);
  }
  // asking has to happen right inside the tap
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('Notifications are blocked. Turn them on in Settings → Notifications → Remote PC.');
  try {
    if (!push.reg) push.reg = await navigator.serviceWorker.register('/sw.js');
    if (!push.key) push.key = (await api('/api/push')).key;
    await navigator.serviceWorker.ready;
    const sub = (await push.reg.pushManager.getSubscription()) || await push.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(push.key) });
    await api('/api/push/subscribe', { body: sub.toJSON() });
    push.on = true; paintBell(); buzz(20);
    toast('Notifications on. You’ll get a test one now');
  } catch (err) { toast('Couldn’t turn on notifications: ' + err.message); }
});

// =============== boot ===============
document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollAgents(); if (view === 'chat') loadChat(true); if (view === 'win' && win.id && (!win.ws || win.ws.readyState > 1)) { const i = win.id; win.id = null; openWin(i); } } });
async function boot() {
  try {
    const r = await fetch('/api/info', { cache: 'no-store' });
    if (r.status === 401) { authed = false; return route(); }
    info = await r.json();
    authed = true;
    $('#host-line').textContent = `On ${info.host}`;
    await pollAgents();
    route();
    initPush();
  } catch {
    $('#host-line').textContent = 'Can’t reach your PC. Retrying…';
    if (!view) { authed = true; show('agents'); renderAgents(); authed = false; }
    setTimeout(boot, 2500);
  }
}
boot();

// Reads Claude Code + Codex conversations straight from their session files (CLI, VS Code, anywhere)
// and sends new prompts by resuming those sessions headlessly.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude', 'projects');
const CODEX_DIR = path.join(HOME, '.codex', 'sessions');
const NPM = path.join(process.env.APPDATA || '', 'npm', 'node_modules');
// Where the agent CLIs live: env override, npm global install, or Claude's native installer
const CLAUDE_BIN = [process.env.RPC_CLAUDE_BIN, path.join(NPM, '@anthropic-ai/claude-code/bin/claude.exe'), path.join(HOME, '.local', 'bin', 'claude.exe'), path.join(NPM, '@anthropic-ai/claude-code/cli.js')].filter(Boolean).find(fs.existsSync);
const CODEX_JS = [process.env.RPC_CODEX_JS, path.join(NPM, '@openai/codex/bin/codex.js')].filter(Boolean).find(fs.existsSync);

const RECENT_DAYS = 21;
const MAX_PER_TOOL = 40;   // shown
const SCAN_PER_TOOL = 200; // looked at (lots of files are headless runs by other tools)
const WORKING_STALE_MS = 15 * 60 * 1000; // mid-turn but silent this long => it probably died

// ---------- file helpers ----------
function readSlice(file, start, len) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, start); return b.subarray(0, n).toString('utf8'); }
  finally { fs.closeSync(fd); }
}
function headLines(file, size, bytes) { return readSlice(file, 0, Math.min(size, bytes)).split('\n').slice(0, -1); }
function tailLines(file, size, bytes) {
  const start = Math.max(0, size - bytes);
  const lines = readSlice(file, start, size - start).split('\n');
  if (start > 0) lines.shift(); // partial first line
  return lines;
}
const parse = (l) => { if (!l || l[0] !== '{') return null; try { return JSON.parse(l); } catch { return null; } };
function walk(dir, depth, out = []) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) walk(p, depth - 1, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}
const base = (p) => (p ? String(p).split(/[\\/]/).filter(Boolean).pop() : '');
const clip = (s, n = 90) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const isNoise = (t) => !t || /^\s*<(command-|local-command|system-reminder|environment_context|user_instructions|permissions|user_shell|turn_aborted|task-notification)/.test(t) || /^# AGENTS\.md/.test(t) || /^Caveat: /.test(t);

// ---------- Claude ----------
function claudeTool(name, input = {}) {
  const f = base(input.file_path || input.notebook_path || input.path);
  switch (name) {
    case 'Bash': case 'PowerShell': return { icon: 'terminal', text: clip(input.description || input.command) };
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return { icon: 'pencil', text: `Edited ${f}`, file: input.file_path };
    case 'Write': return { icon: 'doc', text: `Wrote ${f}`, file: input.file_path };
    case 'Read': return { icon: 'eye', text: `Read ${f}` };
    case 'Grep': case 'Glob': return { icon: 'search', text: `Searched ${clip(input.pattern, 50)}` };
    case 'WebSearch': return { icon: 'globe', text: `Searched the web: ${clip(input.query, 60)}` };
    case 'WebFetch': return { icon: 'globe', text: `Opened ${clip(input.url, 60)}` };
    case 'Task': case 'Agent': return { icon: 'spark', text: clip(input.description || 'Ran a sub-agent') };
    case 'TodoWrite': return { icon: 'list', text: 'Updated its plan' };
    default: return { icon: 'gear', text: clip(name.replace(/^mcp__\w+?__/, '').replace(/_/g, ' ')) };
  }
}
function claudeItems(lines) {
  const items = []; let state = 'done', title = null, mode = null, lastTs = 0, cwd = null, entry = null;
  for (const l of lines) {
    const j = parse(l); if (!j) continue;
    if (j.cwd) cwd = j.cwd;
    if (j.entrypoint && !entry) entry = j.entrypoint;
    if (j.type === 'ai-title' && j.aiTitle) title = j.aiTitle;
    if (j.type === 'permission-mode') mode = j.permissionMode;
    if (j.isSidechain || j.isMeta) continue;
    const ts = j.timestamp ? Date.parse(j.timestamp) : 0;
    if (j.type === 'system' && j.subtype === 'turn_duration') { state = 'done'; continue; }
    if (j.type === 'user' && j.message) {
      const c = j.message.content;
      const human = !j.origin || j.origin.kind === 'human';
      const said = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '';
      if (/^\[Request interrupted/.test(said)) { state = 'done'; continue; } // stopped (Esc): not a message, and not working
      if (typeof c === 'string') {
        if (human && !isNoise(c)) { items.push({ k: 'user', text: c, ts }); state = 'working'; lastTs = ts; }
      } else if (Array.isArray(c)) {
        const t = c.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
        if (t && human && !isNoise(t)) { items.push({ k: 'user', text: t, ts }); state = 'working'; lastTs = ts; }
        else if (c.some((x) => x.type === 'tool_result')) state = 'working';
      }
    } else if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
      for (const b of j.message.content) {
        if (b.type === 'text' && b.text && b.text.trim() && b.text.trim() !== 'No response requested.') items.push({ k: 'agent', text: b.text, ts });
        else if (b.type === 'tool_use') items.push({ k: 'step', ...claudeTool(b.name, b.input), ts });
      }
      lastTs = ts;
      state = j.message.stop_reason === 'end_turn' ? 'done' : 'working';
    }
  }
  return { items, state, title, mode, lastTs, cwd, entry };
}

// ---------- Codex ----------
function codexTool(p) {
  const raw = p.input || p.arguments || '';
  if (p.name === 'apply_patch' || /\*\*\* (Update|Add) File:/.test(raw)) {
    const files = [...raw.matchAll(/\*\*\* (?:Update|Add) File: (.+)/g)].map((m) => base(m[1].trim()));
    return { icon: 'pencil', text: files.length ? `Edited ${files.slice(0, 3).join(', ')}${files.length > 3 ? '…' : ''}` : 'Edited files' };
  }
  // newer Codex wraps tool calls in a little script: tools.exec_command({cmd:"..."}) / tools.mcp__srv__tool(...)
  const sc = raw.match(/exec_command\(\{\s*cmd:\s*"((?:[^"\\]|\\.)*)"/);
  if (sc) return { icon: 'terminal', text: clip(sc[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')) };
  const mc = raw.match(/tools\.mcp__\w+?__(\w+)\(/);
  if (mc) return { icon: 'gear', text: clip(mc[1].replace(/_/g, ' ')) };
  if (/tools\.(apply_patch|edit)/.test(raw)) return { icon: 'pencil', text: 'Edited files' };
  if (p.name === 'exec' || p.name === 'shell' || p.name === 'exec_command') {
    let cmd = raw;
    try { const a = JSON.parse(raw); cmd = Array.isArray(a.command) ? a.command.join(' ') : a.cmd || a.command || raw; } catch {}
    cmd = String(cmd).split('\n').find((x) => x.trim() && !/^(set|\$ErrorAction|#)/i.test(x.trim())) || cmd;
    return { icon: 'terminal', text: clip(cmd) };
  }
  if (p.name === 'request_user_input_async') return { icon: 'spark', text: 'Asked you a question' };
  return { icon: 'gear', text: clip(String(p.name || 'tool').replace(/_/g, ' ')) };
}
function codexItems(lines) {
  const items = []; let state = 'done', meta = null, lastTs = 0;
  for (const l of lines) {
    const j = parse(l); if (!j) continue;
    const ts = j.timestamp ? Date.parse(j.timestamp) : 0;
    const p = j.payload || {};
    if (j.type === 'session_meta') { meta = p; continue; }
    if (j.type === 'event_msg') {
      if (/^(task_complete|turn_complete|turn_aborted)$/.test(p.type)) state = 'done';
      else if (p.type === 'item_completed' && p.item && p.item.type === 'Extension' && p.item.kind === 'web.search') items.push({ k: 'step', icon: 'globe', text: `Searched the web: ${clip(p.item.query, 60)}`, ts });
      else if (p.type === 'item_completed' && p.item && p.item.type === 'McpToolCall') items.push({ k: 'step', icon: 'gear', text: clip(`${p.item.tool || 'tool'}`.replace(/_/g, ' ')), ts });
      continue;
    }
    if (j.type !== 'response_item') continue;
    if (p.type === 'message') {
      const text = (p.content || []).filter((c) => c.text).map((c) => c.text).join('\n');
      if (p.role === 'user' && !isNoise(text)) { items.push({ k: 'user', text, ts }); state = 'working'; lastTs = ts; }
      else if (p.role === 'assistant' && text.trim()) {
        items.push({ k: 'agent', text, ts, faint: p.phase === 'commentary' });
        lastTs = ts;
        if (p.phase === 'final_answer') state = 'done';
      }
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      items.push({ k: 'step', ...codexTool(p), ts }); state = 'working'; lastTs = ts;
    }
  }
  return { items, state, meta, lastTs };
}

// ---------- index ----------
const cache = new Map();   // file -> { mtime, size, summary }
const byId = new Map();    // agent id -> { file, tool }
const runs = new Map();    // agent id -> { child, startedAt, error }
const pendingNew = new Map(); // temp id -> { tool, cwd, prompt, child, realId }
const lastErrors = new Map(); // agent id -> last failed run from the phone
// sessions started from the phone run headless too; remember them so they aren't filtered out
const KNOWN_FILE = path.join(HOME, '.remote-pc', 'agents.json');
const known = new Set((() => { try { return JSON.parse(fs.readFileSync(KNOWN_FILE, 'utf8')); } catch { return []; } })());
const remember = (sid) => { if (known.has(sid)) return; known.add(sid); try { fs.writeFileSync(KNOWN_FILE, JSON.stringify([...known].slice(-500))); } catch {} };

function summarize(file, tool, st) {
  const c = cache.get(file);
  if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.summary;
  let s;
  if (tool === 'claude') {
    const head = claudeItems(headLines(file, st.size, 200e3));
    const tail = claudeItems(tailLines(file, st.size, 600e3));
    const id = path.basename(file, '.jsonl');
    const firstUser = head.items.find((i) => i.k === 'user') || tail.items.find((i) => i.k === 'user');
    s = { id: 'c_' + id, sid: id, tool, cwd: tail.cwd || head.cwd, title: tail.title || head.title || (firstUser && clip(firstUser.text, 70)), mode: tail.mode || head.mode, entry: head.entry || tail.entry, rawState: tail.state, last: lastText(tail.items) };
  } else {
    const head = codexItems(headLines(file, st.size, 400e3));
    const tail = codexItems(tailLines(file, st.size, 600e3));
    const m = head.meta || {};
    const firstUser = head.items.find((i) => i.k === 'user') || tail.items.find((i) => i.k === 'user');
    s = { id: 'x_' + (m.id || path.basename(file, '.jsonl')), sid: m.id, tool, cwd: m.cwd, source: m.source, title: firstUser && clip(firstUser.text, 70), rawState: tail.state, last: lastText(tail.items) };
  }
  if (!s.sid) return null;
  cache.set(file, { mtime: st.mtimeMs, size: st.size, summary: s });
  return s;
}
function lastText(items) {
  // `ask`: the full message ends with a question (checked before clipping, so long replies count too)
  for (let i = items.length - 1; i >= 0; i--) if (items[i].k === 'agent' || items[i].k === 'step') return { k: items[i].k, text: clip(items[i].text, 140), ask: items[i].k === 'agent' && /\?\s*$/.test(items[i].text) };
  return null;
}
function status(s, mtime) {
  if (runs.has(s.id)) return 'working';
  if (s.rawState === 'working' && Date.now() - mtime < WORKING_STALE_MS) return 'working';
  if (s.last && s.last.ask) return 'needs';
  return 'done';
}

function list() {
  const cutoff = Date.now() - RECENT_DAYS * 86400e3;
  const files = [];
  // Claude: top-level <project>/<session>.jsonl only (subagent transcripts live deeper)
  for (const f of walk(CLAUDE_DIR, 1)) { if (path.dirname(path.dirname(f)) === CLAUDE_DIR) files.push({ f, tool: 'claude' }); }
  for (const f of walk(CODEX_DIR, 3)) files.push({ f, tool: 'codex' });
  const stats = files.map((x) => { try { return { ...x, st: fs.statSync(x.f) }; } catch { return null; } }).filter((x) => x && x.st.mtimeMs > cutoff);
  const pick = (tool) => stats.filter((x) => x.tool === tool).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, SCAN_PER_TOOL);
  const out = [], shown = { claude: 0, codex: 0 };
  for (const x of [...pick('claude'), ...pick('codex')]) {
    if (shown[x.tool] >= MAX_PER_TOOL) continue;
    let s; try { s = summarize(x.f, x.tool, x.st); } catch { s = null; }
    if (!s || !s.title) continue;
    if (s.entry && /^sdk/.test(s.entry) && !known.has(s.sid)) continue; // headless runs by other tools
    byId.set(s.id, { file: x.f, tool: x.tool });
    shown[x.tool]++;
    out.push({ id: s.id, tool: s.tool, title: s.title, cwd: s.cwd, project: base(s.cwd), updatedAt: x.st.mtimeMs, status: status(s, x.st.mtimeMs), last: s.last, source: s.source });
  }
  for (const [tid, p] of pendingNew) if (!p.realId) out.push({ id: tid, tool: p.tool, title: clip(p.prompt, 70), cwd: p.cwd, project: base(p.cwd), updatedAt: p.startedAt, status: p.error ? 'error' : 'working', last: p.error ? { k: 'agent', text: p.error } : null });
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function detail(id) {
  const p = pendingNew.get(id);
  if (p) {
    if (p.realId) { const d = detail(p.realId); if (d) return d; } // file may lag a moment behind the id
    return { id, tool: p.tool, title: clip(p.prompt, 70), cwd: p.cwd, project: base(p.cwd), status: p.error ? 'error' : 'working', items: [{ k: 'user', text: p.prompt, ts: p.startedAt }, ...(p.error ? [{ k: 'error', text: p.error }] : [])], running: !p.error };
  }
  let ref = byId.get(id);
  if (!ref) { list(); ref = byId.get(id); }
  if (!ref) return null;
  const st = fs.statSync(ref.file);
  const lines = tailLines(ref.file, st.size, 3e6);
  const r = ref.tool === 'claude' ? claudeItems(lines) : codexItems(lines);
  const s = summarize(ref.file, ref.tool, st);
  const run = runs.get(id);
  const items = r.items.slice(-160);
  const le = lastErrors.get(id);
  if (le) items.push({ k: 'error', text: le.text });
  const live = !runs.has(id) && !!livePid(s);
  return { id, tool: ref.tool, title: s.title, cwd: s.cwd, project: base(s.cwd), status: status(s, st.mtimeMs), updatedAt: st.mtimeMs, items, running: runs.has(id), live, version: `${st.mtimeMs}:${st.size}:${runs.has(id)}:${live}` };
}

// ---------- live sessions (open in a terminal on the PC) ----------
// Claude Code writes ~/.claude/sessions/<pid>.json for each running session. If the conversation is
// open in a terminal (incl. VS Code's), phone messages are typed straight into that terminal, so it
// stays one conversation and you see it on the PC as it happens.
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
const BIN_DIR = path.join(HOME, '.remote-pc', 'bin');
const INJECT = path.join(BIN_DIR, 'rpc-inject.exe');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
let liveCache = { at: 0, map: new Map() };
function liveSessions() {
  if (Date.now() - liveCache.at < 2000) return liveCache.map;
  const map = new Map();
  let files = []; try { files = fs.readdirSync(SESSIONS_DIR).filter((f) => /^\d+\.json$/.test(f)); } catch {}
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      // interactive terminal sessions only: headless runs (sdk-cli) and IDE panels have no terminal to type into
      if (j.kind === 'interactive' && j.entrypoint === 'cli' && j.sessionId && alive(j.pid)) {
        const prev = map.get(j.sessionId);
        if (!prev || j.startedAt > prev.startedAt) map.set(j.sessionId, { pid: j.pid, startedAt: j.startedAt || 0 });
      }
    } catch {}
  }
  liveCache = { at: Date.now(), map };
  return map;
}
const livePid = (s) => (s && s.tool === 'claude' && s.sid && liveSessions().get(s.sid) || {}).pid || null;
function ensureInject() {
  if (fs.existsSync(INJECT)) return INJECT;
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const r = require('child_process').spawnSync(csc, ['/nologo', '/optimize', `/out:${INJECT}`, path.join(__dirname, 'inject.cs')], { windowsHide: true, encoding: 'utf8' });
  if (!fs.existsSync(INJECT)) throw new Error('Couldn’t build the terminal helper: ' + clip(r.stdout || r.stderr || 'csc failed', 200));
  return INJECT;
}
function inject(pid, ...args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ensureInject(), [String(pid), ...args], { windowsHide: true });
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Couldn’t type into the terminal (${clip(err.trim(), 120) || code})`))));
  });
}
async function typeInto(pid, text) {
  await inject(pid, 'text', Buffer.from(text, 'utf8').toString('base64'));
  // a separate Enter after a beat, so the terminal treats the text as typed/pasted and Enter as "send"
  await new Promise((r) => setTimeout(r, 250 + Math.min(1500, text.length)));
  await inject(pid, 'key', 'enter');
}

// ---------- prompting ----------
function claudeArgs({ sid, full, mode }) {
  const a = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', full ? 'bypassPermissions' : mode || 'acceptEdits'];
  if (sid) a.push('--resume', sid);
  return a;
}
function codexArgs({ sid, cwd, full }) {
  const a = ['exec', '--json', '--skip-git-repo-check', '-C', cwd];
  if (full) a.push('--dangerously-bypass-approvals-and-sandbox'); else a.push('-s', 'workspace-write');
  if (sid) a.push('resume', sid);
  a.push('-');
  return a;
}
function launch(tool, opts, prompt, onEvent) {
  const [cmd, args] = tool === 'claude'
    ? (CLAUDE_BIN.endsWith('.js') ? [process.execPath, [CLAUDE_BIN, ...claudeArgs(opts)]] : [CLAUDE_BIN, claudeArgs(opts)])
    : [process.execPath, [CODEX_JS, ...codexArgs(opts)]];
  // The run talks to files, not pipes, and is detached: if Remote PC restarts, the agent keeps going.
  const dir = path.join(HOME, '.remote-pc', 'runs'); fs.mkdirSync(dir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const inFile = path.join(dir, stamp + '.prompt'), outFile = path.join(dir, stamp + '.jsonl'), errFile = path.join(dir, stamp + '.err');
  fs.writeFileSync(inFile, prompt);
  const fin = fs.openSync(inFile, 'r'), fout = fs.openSync(outFile, 'w'), ferr = fs.openSync(errFile, 'w');
  const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, detached: true, stdio: [fin, fout, ferr], env: { ...process.env, REMOTE_PC: '1' } });
  [fin, fout, ferr].forEach((fd) => { try { fs.closeSync(fd); } catch {} });
  let pos = 0, buf = '';
  const pump = () => {
    try {
      const size = fs.statSync(outFile).size; if (size <= pos) return;
      buf += readSlice(outFile, pos, size - pos); pos = size; let i;
      while ((i = buf.indexOf('\n')) >= 0) { const j = parse(buf.slice(0, i).trim()); buf = buf.slice(i + 1); if (j) onEvent(j); }
    } catch {}
  };
  const timer = setInterval(pump, 300);
  child.on('exit', () => { clearInterval(timer); pump(); setTimeout(() => [inFile, outFile, errFile].forEach((f) => fs.rm(f, { force: true }, () => {})), 5000); });
  const stderr = () => { try { const st = fs.statSync(errFile); return readSlice(errFile, Math.max(0, st.size - 2000), Math.min(st.size, 2000)); } catch { return ''; } };
  return { child, stderr };
}
function errorFrom(ev) {
  if (ev.type === 'result' && ev.is_error) return ev.result || 'The agent stopped with an error';
  if (ev.type === 'error' || ev.type === 'turn.failed') return (ev.error && ev.error.message) || ev.message || 'The agent stopped with an error';
  return null;
}

// stop a run we started (whole process tree: agents spawn shells) and wait for it to exit
function killRun(run) {
  if (!run || !run.child || run.child.exitCode !== null) return Promise.resolve();
  run.stopped = true;
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 6000);
    run.child.once('exit', () => { clearTimeout(t); setTimeout(resolve, 300); });
    spawn('taskkill', ['/pid', String(run.child.pid), '/t', '/f'], { windowsHide: true });
  });
}

async function send(id, prompt, { full } = {}) {
  if (!prompt || !prompt.trim()) throw new Error('Type something first');
  const pend = pendingNew.get(id); if (pend && pend.realId) id = pend.realId;
  let ref = byId.get(id); if (!ref) { list(); ref = byId.get(id); }
  if (!ref) throw new Error('Still starting up. Try again in a second.');
  const st = fs.statSync(ref.file);
  const s = summarize(ref.file, ref.tool, st);
  // interrupt: if we're running it, stop it and continue with the new message
  const current = runs.get(id) || (pend && pend.child && { child: pend.child, stopped: false });
  // open in a terminal on the PC: type it there (Claude Code queues it if it's mid-task)
  const pid = !current && livePid(s);
  if (pid) { lastErrors.delete(id); await typeInto(pid, prompt.trim()); return { id, live: true }; }
  if (current) { await killRun(current); if (pend) pend.stopped = true; }
  else if (status(s, st.mtimeMs) === 'working') throw new Error('This one was started on your PC and is still working. You can reply when it finishes.');
  if (ref.tool === 'claude' && !CLAUDE_BIN) throw new Error('Claude Code CLI not found');
  if (ref.tool === 'codex' && !CODEX_JS) throw new Error('Codex CLI not found');
  const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : HOME;
  lastErrors.delete(id);
  const run = { startedAt: Date.now(), error: null, stopped: false };
  const h = launch(ref.tool, { sid: s.sid, cwd, full, mode: s.mode }, prompt, (ev) => { const e = errorFrom(ev); if (e) run.error = e; });
  run.child = h.child;
  runs.set(id, run);
  h.child.on('exit', (code) => {
    if (runs.get(id) === run) runs.delete(id);
    if (run.stopped) return;
    if (code && !run.error) run.error = clip(h.stderr().split('\n').filter(Boolean).pop() || `Exited with code ${code}`, 300);
    if (run.error) lastErrors.set(id, { text: run.error, at: Date.now() });
  });
  return { id, interrupted: !!current };
}
function create(tool, cwd, prompt, { full } = {}) {
  if (!prompt || !prompt.trim()) throw new Error('Type something first');
  if (!cwd || !fs.existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`);
  if (tool === 'claude' && !CLAUDE_BIN) throw new Error('Claude Code CLI not found');
  if (tool === 'codex' && !CODEX_JS) throw new Error('Codex CLI not found');
  const tid = 'n_' + Date.now().toString(36);
  const p = { tool, cwd, prompt, startedAt: Date.now(), realId: null, error: null };
  pendingNew.set(tid, p);
  const h = launch(tool, { cwd, full }, prompt, (ev) => {
    const sid = ev.session_id || ev.thread_id;
    if (sid && !p.realId) {
      p.realId = (tool === 'claude' ? 'c_' : 'x_') + sid;
      remember(sid);
      p.run = { child: h.child, startedAt: p.startedAt, stopped: false };
      runs.set(p.realId, p.run);
    }
    const e = errorFrom(ev); if (e) p.error = e;
  });
  p.child = h.child;
  h.child.on('exit', (code) => {
    if (p.realId && runs.get(p.realId) === p.run) runs.delete(p.realId);
    if (p.stopped || (p.run && p.run.stopped)) { p.error = null; if (p.realId) setTimeout(() => pendingNew.delete(tid), 60000); return; }
    if (code && !p.error) p.error = clip(h.stderr().split('\n').filter(Boolean).pop() || `Exited with code ${code}`, 300);
    if (p.realId) setTimeout(() => pendingNew.delete(tid), 60000);
  });
  return tid;
}

async function stop(id) {
  const p = pendingNew.get(id); const realId = p ? p.realId : id;
  const run = runs.get(realId) || (p && p.child && { child: p.child });
  if (!run || !run.child) {
    // open in a terminal: Esc is Claude Code's "stop"
    const ref = byId.get(realId); const s = ref && summarize(ref.file, ref.tool, fs.statSync(ref.file));
    const pid = livePid(s);
    if (pid) return inject(pid, 'key', 'esc');
    throw new Error('This one was started on your PC, so it can only be stopped there.');
  }
  if (p) p.stopped = true;
  await killRun(run);
}
function projects() {
  const seen = new Map();
  for (const a of list()) if (a.cwd && !seen.has(a.cwd.toLowerCase()) && fs.existsSync(a.cwd)) seen.set(a.cwd.toLowerCase(), { path: a.cwd, name: base(a.cwd) || a.cwd });
  return [...seen.values()].slice(0, 12);
}

module.exports = { list, detail, send, create, stop, projects, available: { claude: !!CLAUDE_BIN, codex: !!CODEX_JS } };

// What an agent changed (git) and which local sites are running (for Preview).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const run = (cmd, args, cwd) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, windowsHide: true, maxBuffer: 20e6, timeout: 15000 }, (err, stdout) => resolve(err ? null : stdout));
});

async function changes(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return { git: false, files: [] };
  const root = (await run('git', ['rev-parse', '--show-toplevel'], cwd) || '').trim();
  if (!root) return { git: false, files: [] };
  const hasHead = !!(await run('git', ['rev-parse', '--verify', 'HEAD'], root));
  const num = await run('git', hasHead ? ['diff', 'HEAD', '--numstat'] : ['diff', '--cached', '--numstat'], root) || '';
  const files = num.split('\n').filter(Boolean).map((l) => {
    const [a, d, ...p] = l.split('\t');
    return { path: p.join('\t'), add: a === '-' ? null : +a, del: d === '-' ? null : +d, status: 'modified' };
  });
  const untracked = (await run('git', ['ls-files', '--others', '--exclude-standard'], root) || '').split('\n').filter(Boolean);
  for (const p of untracked.slice(0, 200)) {
    let lines = null;
    try { const st = fs.statSync(path.join(root, p)); if (st.size < 2e6) lines = fs.readFileSync(path.join(root, p), 'utf8').split('\n').length; } catch {}
    files.push({ path: p, add: lines, del: 0, status: 'new' });
  }
  const branch = (await run('git', ['branch', '--show-current'], root) || '').trim();
  return { git: true, root, branch, files };
}

async function diff(cwd, file) {
  const root = (await run('git', ['rev-parse', '--show-toplevel'], cwd) || '').trim();
  if (!root) throw new Error('Not a git project');
  const abs = path.resolve(root, file);
  if (!abs.startsWith(path.resolve(root))) throw new Error('Outside the project');
  const tracked = await run('git', ['ls-files', '--error-unmatch', '--', file], root);
  if (tracked === null) {
    const text = fs.readFileSync(abs, 'utf8').slice(0, 300e3);
    return text.split('\n').map((l) => '+' + l).join('\n');
  }
  const hasHead = !!(await run('git', ['rev-parse', '--verify', 'HEAD'], root));
  return (await run('git', ['diff', hasHead ? 'HEAD' : '--cached', '--unified=3', '--', file], root) || '').slice(0, 600e3);
}

// ---------- local sites ----------
const DEV = /^(node|bun|deno|python\d*|pythonw|py|ruby|php|java|dotnet|go|hugo|caddy|nginx|httpd|uvicorn|gunicorn|cargo|.*vite.*|.*next.*|.*server.*)$/i;
async function sites(skip = []) {
  const [ns, tl] = await Promise.all([run('netstat', ['-ano', '-p', 'TCP']), run('tasklist', ['/fo', 'csv', '/nh'])]);
  const names = new Map();
  for (const l of (tl || '').split('\n')) { const m = l.match(/^"([^"]+)","(\d+)"/); if (m) names.set(m[2], m[1].replace(/\.exe$/i, '')); }
  const seen = new Map();
  for (const l of (ns || '').split('\n')) {
    const m = l.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
    if (!m) continue;
    const [, host, portS, pid] = m, port = +portS;
    if (!/^(0\.0\.0\.0|127\.0\.0\.1|\[::\]|\[::1\])$/.test(host)) continue;
    if (port < 1024 || port >= 49152 || skip.includes(port) || seen.has(port)) continue;
    const name = names.get(pid) || '';
    if (!DEV.test(name)) continue;
    seen.set(port, { port, process: name });
  }
  return [...seen.values()].sort((a, b) => a.port - b.port);
}

module.exports = { changes, diff, sites };

// Phone notifications (Web Push): when an agent finishes, needs you, or hits an error.
// Works on iPhone for the Home Screen app (iOS 16.4+) over HTTPS, and on Android/desktop browsers.
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

function createPush({ dataDir, config, saveConfig, agents }) {
  // VAPID keys identify this server to the push services; made once and kept in config.json
  if (!config.vapid || !config.vapid.publicKey) { config.vapid = webpush.generateVAPIDKeys(); saveConfig(); }
  // the contact "subject" must be a real-looking URL: Apple rejects mailto:…@localhost with 403 BadJwtToken
  webpush.setVapidDetails(config.pushSubject || 'https://github.com/remote-pc', config.vapid.publicKey, config.vapid.privateKey);

  const SUBS_FILE = path.join(dataDir, 'push.json');
  let subs = []; try { subs = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch {}
  const saveSubs = () => { try { fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2)); } catch {} };

  async function send(payload) {
    const body = JSON.stringify(payload);
    const dead = []; let ok = 0; const errors = [];
    await Promise.all(subs.map((s) => webpush.sendNotification(s, body, { TTL: 3600, urgency: 'high', topic: String(payload.tag || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined })
      .then(() => { ok++; })
      .catch((e) => {
        if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.endpoint);
        else { console.log('  push failed:', e.statusCode || e.message, e.body || ''); errors.push(`${e.statusCode || ''} ${e.body || e.message}`.trim()); }
      })));
    if (dead.length) { subs = subs.filter((s) => !dead.includes(s.endpoint)); saveSubs(); }
    return { ok, errors };
  }

  // watch agents: notify on working -> done / needs you / error
  const last = new Map(); let primed = false;
  const LABEL = { claude: 'Claude Code', codex: 'Codex' };
  function check() {
    if (!subs.length) { primed = false; return; }
    let list; try { list = agents.list(); } catch { return; }
    for (const a of list) {
      const prev = last.get(a.id); last.set(a.id, a.status);
      if (!primed || prev !== 'working' || a.status === 'working') continue;
      const what = a.status === 'needs' ? 'needs you' : a.status === 'error' ? 'hit a problem' : 'is done';
      const text = a.last && a.last.text ? a.last.text : '';
      send({
        title: `${a.title || LABEL[a.tool]} ${what}`,
        body: `${a.project ? a.project + ' · ' : ''}${text}`.slice(0, 180),
        tag: a.id, url: `/#/a/${encodeURIComponent(a.id)}`,
      });
    }
    primed = true; // first pass only learns the current state, so restarting doesn't spam you
  }
  setInterval(check, 4000);

  return {
    publicKey: config.vapid.publicKey,
    count: () => subs.length,
    subscribe(sub) {
      if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys) throw new Error('Bad subscription');
      subs = subs.filter((s) => s.endpoint !== sub.endpoint); subs.push({ endpoint: sub.endpoint, keys: sub.keys }); saveSubs();
      check();
    },
    unsubscribe(endpoint) { subs = subs.filter((s) => s.endpoint !== endpoint); saveSubs(); },
    has: (endpoint) => subs.some((s) => s.endpoint === endpoint),
    async test() {
      const r = await send({ title: 'Notifications are on', body: 'You’ll hear from your PC when an agent finishes or needs you.', tag: 'test', url: '/#/' });
      if (!r.ok) throw new Error(r.errors.length ? `The push service refused it (${r.errors[0].slice(0, 80)})` : 'No phone is signed up for notifications');
    },
  };
}
module.exports = { createPush };

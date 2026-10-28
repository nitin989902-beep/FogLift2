// FogLift server: zero dependencies. Run with: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const WINDOW_MS = 60 * 1000;      // a tap counts for 60 seconds
const COOLDOWN_MS = 20 * 1000;    // one tap per device per type every 20 s
const SAMPLE_MS = 5 * 1000;       // graph resolution
const DEFAULT_THRESHOLD = 30;     // % of class that triggers an alert
const MIN_LOST_FOR_ALERT = 2;     // never alert on a single student

const sessions = new Map();

// ---------- helpers ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/teacher': ['teacher.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function serveFile(res, [file, type]) {
  fs.readFile(path.join(PUBLIC, file), (err, data) => {
    if (err) { res.writeHead(500); return res.end('File error'); }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 4096) { req.destroy(); reject(new Error('Body too large')); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

function newCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alike characters
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (sessions.has(code));
  return code;
}

function isTeacher(s, token) {
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(s.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- confusion maths ----------
// A student counts as "lost" if their latest tap in the last 60 s was "I'm lost".
// Tapping "Got it" clears them, so the graph falls when the fog lifts.
function live(s, now) {
  const cut = now - WINDOW_MS;
  const latest = new Map();
  for (let i = s.taps.length - 1; i >= 0 && s.taps[i].t >= cut; i--) {
    const tap = s.taps[i];
    if (!latest.has(tap.d)) latest.set(tap.d, tap.type);
  }
  let lost = 0, got = 0;
  for (const type of latest.values()) type === 'lost' ? lost++ : got++;
  const online = onlineCount(s);
  const denom = Math.max(online, latest.size);
  const pct = denom ? Math.round((lost / denom) * 100) : 0;
  return { lost, got, online, pct };
}

function onlineCount(s) {
  const devices = new Set();
  for (const st of s.streams) if (st.role === 'student') devices.add(st.device);
  return devices.size;
}

function snapshot(s, now = Date.now()) {
  return {
    code: s.code, title: s.title, startedAt: s.startedAt, endedAt: s.endedAt,
    ended: !!s.endedAt, now, threshold: s.threshold,
    ...live(s, now),
    history: s.history.slice(-120),   // last 10 minutes
    markers: s.markers,
  };
}

function broadcast(s) {
  const full = JSON.stringify(snapshot(s));
  const lite = JSON.stringify({ title: s.title, ended: !!s.endedAt });
  for (const st of s.streams) {
    st.res.write(`event: state\ndata: ${st.role === 'teacher' ? full : lite}\n\n`);
  }
}

function sample(s, now) {
  const v = live(s, now);
  s.history.push({ t: now, lost: v.lost, got: v.got, online: v.online, pct: v.pct });
}

function topicAt(s, time) {
  let label = null;
  for (const m of [...s.markers].sort((a, b) => a.t - b.t)) if (m.t <= time) label = m.label;
  return label;
}

function buildReport(s) {
  const end = s.endedAt || Date.now();
  const thr = s.threshold;

  // spikes: runs of samples at or above the threshold
  const peaks = [];
  let cur = null;
  for (const h of s.history) {
    const hot = h.pct >= thr && h.lost >= MIN_LOST_FOR_ALERT;
    if (hot && !cur) cur = { start: h.t, end: h.t, peakT: h.t, peakPct: h.pct, peakLost: h.lost, online: h.online };
    else if (hot) {
      cur.end = h.t;
      if (h.pct > cur.peakPct) Object.assign(cur, { peakT: h.t, peakPct: h.pct, peakLost: h.lost, online: h.online });
    } else if (cur) { peaks.push(cur); cur = null; }
  }
  if (cur) peaks.push(cur);
  peaks.forEach((p) => { p.topic = topicAt(s, p.peakT); });

  // topics: the stretch of class between one marker and the next
  const marks = [...s.markers].sort((a, b) => a.t - b.t);
  const bounds = marks.map((m, i) => ({ label: m.label, from: m.t, to: i + 1 < marks.length ? marks[i + 1].t : end + 1 }));
  if (!marks.length) bounds.push({ label: 'Whole session', from: s.startedAt, to: end + 1 });
  else if (marks[0].t > s.startedAt) bounds.unshift({ label: 'Before the first topic marker', from: s.startedAt, to: marks[0].t });

  const topics = bounds.map((b) => {
    const hs = s.history.filter((h) => h.t >= b.from && h.t < b.to);
    const lostTaps = s.taps.filter((t) => t.type === 'lost' && t.t >= b.from && t.t < b.to).length;
    return {
      label: b.label, from: b.from, to: b.to, lostTaps,
      avgPct: hs.length ? Math.round(hs.reduce((a, h) => a + h.pct, 0) / hs.length) : 0,
      peakPct: hs.reduce((a, h) => Math.max(a, h.pct), 0),
    };
  }).sort((a, b) => b.peakPct - a.peakPct || b.lostTaps - a.lostTaps);

  return {
    title: s.title, startedAt: s.startedAt, endedAt: end, threshold: thr,
    durationMs: end - s.startedAt,
    peakOnline: s.history.reduce((a, h) => Math.max(a, h.online), 0),
    totalLost: s.taps.filter((t) => t.type === 'lost').length,
    totalGot: s.taps.filter((t) => t.type === 'gotit').length,
    peaks, topics, history: s.history, markers: s.markers,
  };
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = req.method;

  if (m === 'GET' && STATIC[p]) return serveFile(res, STATIC[p]);
  if (m === 'GET' && /^\/s\/[A-Za-z0-9]{4,8}\/?$/.test(p)) return serveFile(res, ['student.html', 'text/html; charset=utf-8']);
  if (m === 'GET' && p === '/api/info') return send(res, 200, { ips: lanIps(), port: PORT });

  if (m === 'POST' && p === '/api/session') {
    const body = await readJson(req);
    const code = newCode();
    const s = {
      code, token: crypto.randomBytes(16).toString('hex'),
      title: String(body.title || 'Untitled class').trim().slice(0, 60) || 'Untitled class',
      startedAt: Date.now(), endedAt: null, threshold: DEFAULT_THRESHOLD,
      taps: [], markers: [], history: [], lastTap: new Map(), streams: new Set(),
    };
    sessions.set(code, s);
    return send(res, 200, { code, token: s.token });
  }

  const r = p.match(/^\/api\/session\/([A-Za-z0-9]+)\/(\w+)$/);
  if (!r) return send(res, 404, { error: 'Not found' });
  const s = sessions.get(r[1].toUpperCase());
  if (!s) return send(res, 404, { error: 'Session not found. Check the code.' });
  const action = r[2];

  if (m === 'GET' && action === 'public') return send(res, 200, { title: s.title, ended: !!s.endedAt });

  if (m === 'GET' && action === 'stream') {
    const role = url.searchParams.get('role') === 'teacher' ? 'teacher' : 'student';
    if (role === 'teacher' && !isTeacher(s, url.searchParams.get('token'))) return send(res, 403, { error: 'Not allowed' });
    const device = String(url.searchParams.get('device') || crypto.randomBytes(6).toString('hex')).slice(0, 64);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const st = { res, role, device };
    s.streams.add(st);
    req.on('close', () => { s.streams.delete(st); broadcast(s); });
    broadcast(s);
    return;
  }

  if (m === 'GET' && (action === 'state' || action === 'report')) {
    if (!isTeacher(s, url.searchParams.get('token'))) return send(res, 403, { error: 'Not allowed' });
    return send(res, 200, action === 'state' ? snapshot(s) : buildReport(s));
  }

  if (m === 'POST') {
    const body = await readJson(req);

    if (action === 'tap') {
      if (s.endedAt) return send(res, 410, { error: 'This class has ended.' });
      const device = String(body.device || '');
      const type = body.type;
      if (device.length < 8 || device.length > 64 || !['lost', 'gotit'].includes(type)) return send(res, 400, { error: 'Bad tap' });
      const now = Date.now();
      const key = `${device}|${type}`;
      const wait = COOLDOWN_MS - (now - (s.lastTap.get(key) || 0));
      if (wait > 0) return send(res, 429, { error: 'Slow down', wait: Math.ceil(wait / 1000) });
      s.lastTap.set(key, now);
      s.taps.push({ t: now, d: device, type });
      broadcast(s);
      return send(res, 200, { ok: true, cooldown: COOLDOWN_MS / 1000 });
    }

    // everything below is teacher-only
    if (!isTeacher(s, body.token)) return send(res, 403, { error: 'Not allowed' });

    if (action === 'marker') {
      if (s.endedAt) return send(res, 410, { error: 'Class has ended.' });
      const label = String(body.label || '').trim().slice(0, 60);
      if (!label) return send(res, 400, { error: 'Type a topic name first.' });
      s.markers.push({ t: Date.now(), label });
      broadcast(s);
      return send(res, 200, { ok: true });
    }

    if (action === 'threshold') {
      const v = Math.round(Number(body.value));
      if (!(v >= 10 && v <= 90)) return send(res, 400, { error: 'Threshold must be 10 to 90' });
      s.threshold = v;
      broadcast(s);
      return send(res, 200, { ok: true });
    }

    if (action === 'end') {
      if (!s.endedAt) { sample(s, Date.now()); s.endedAt = Date.now(); broadcast(s); }
      return send(res, 200, { ok: true });
    }
  }

  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) send(res, 400, { error: 'Bad request' });
    else res.end();
  });
});

// one sample every 5 s keeps the graph moving even when nobody is tapping
setInterval(() => {
  const now = Date.now();
  for (const [code, s] of sessions) {
    if (s.endedAt) { if (now - s.endedAt > 24 * 3600e3) sessions.delete(code); continue; }
    sample(s, now);
    broadcast(s);
  }
}, SAMPLE_MS);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`FogLift running.\n  Teacher: http://localhost:${PORT}/teacher`);
    for (const ip of lanIps()) console.log(`  Students on the same Wi-Fi: http://${ip}:${PORT}`);
  });
}
module.exports = { server };

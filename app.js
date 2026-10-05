(() => {
'use strict';

// ───────────────────────── constants ─────────────────────────
const PREFIX = 'xkcd-multiplayer-room-';
const MAX_PLAYERS = 8;
const MAX_PIECES = 4000;            // scribble segments kept per comic
const HAND = '"Humor Sans","xkcd Script","Patrick Hand","Comic Sans MS","Comic Neue",cursive';
const COLORS = ['#d62728', '#1f77b4', '#2ca02c', '#ff7f0e', '#9467bd', '#8c564b', '#e377c2', '#17becf'];
const BOT_NAMES = ['Beret Guy', 'Black Hat', 'Megan', 'Ponytail'];
const BOT_SAY = ["I don't get it.", 'Ha.', '[citation needed]', "There's a relevant xkcd for this.",
  'Wait, read the title text.', 'Go back one.', "That one's about me.", 'Actually, technically...',
  'Nerd sniped.', 'Is this the one with the raptors?', 'Press Random.', 'I understood that reference.'];
const FALLBACK = { num: 303, title: 'Compiling', img: 'https://imgs.xkcd.com/comics/compiling.png', date: '2007-08-15',
  alt: "(Couldn't reach xkcd for the title text, so this one comic is hard-coded. It's a good one though.)" };

// Where to get comic metadata. xkcd.com sends no CORS headers, so: a same-origin rewrite
// (vercel.json) first, then public mirrors/proxies. Only the host ever fetches.
const xkcdPath = n => (n ? n + '/' : '') + 'info.0.json';
const SOURCES = [
  n => 'xkcd/' + xkcdPath(n),
  n => 'https://xkcd.vercel.app/?comic=' + (n || 'latest'),
  n => 'https://api.allorigins.win/raw?url=' + encodeURIComponent('https://xkcd.com/' + xkcdPath(n)),
];

// ───────────────────────── globals ─────────────────────────
const $ = id => document.getElementById(id);
const stage = $('stage'), img = $('comic'), ov = $('ov'), ctx = ov.getContext('2d');
let mode = 'menu';                  // menu | host | client
let S = null;                       // shared state (authoritative on host, last snapshot on client)
let myId = null, myName = '';
let peer = null, hostConn = null, ticker = null;
const conns = {}, seen = {}, priv = {};   // host-only, per player
const strokesBy = {}, cache = {};         // host-only: scribbles and metadata per comic
let strokes = [], strokesNum = 0;         // scribbles for the comic on screen
let goodSource = 0, navOk = 0, rapOk = 0, lastSnap = 0, entN = 0;
const me = { x: .15 + Math.random() * .7, y: 1.03, pen: 0, sent: '', sentT: 0 };
const draw = { id: null, pts: [] };
let penOn = !matchMedia('(pointer: coarse)').matches;
const R = {};                       // interpolated render positions
let raptorT = -1, seenRap = -1;
let muted = false, audio = null;

const rand = (a = 1, b) => b === undefined ? Math.random() * a : a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const now = () => performance.now() / 1000;
const round3 = (k, v) => typeof v === 'number' ? Math.round(v * 1000) / 1000 : v;
const cleanName = n => String(n || '').replace(/[^\w .\-'!?]/g, '').trim().slice(0, 12) || 'anon';
const myPlayer = () => S && S.players.find(p => p.id === myId);

// ───────────────────────── host: comics ─────────────────────────
// Old xkcd JSON has double-encoded UTF-8 in places; undo it when it's obviously that.
function fixText(s) {
  s = String(s || '');
  if (/[Â-ô][\u0080-¿]/.test(s)) { try { return decodeURIComponent(escape(s)); } catch {} }
  return s;
}
const validComic = c => c && Number.isInteger(c.num) && typeof c.img === 'string' && /^https:\/\/imgs\.xkcd\.com\//.test(c.img);

async function fetchComic(n) {
  if (n && cache[n]) return cache[n];
  const order = SOURCES.map((_, i) => (i + goodSource) % SOURCES.length);
  for (const k of order) {
    try {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 7000);
      const r = await fetch(SOURCES[k](n), { signal: ctl.signal });
      clearTimeout(timer);
      if (!r.ok) continue;
      const j = await r.json();
      const pad = v => String(v || '').padStart(2, '0');
      const c = { num: j.num, title: fixText(j.title || j.safe_title), img: j.img, alt: fixText(j.alt),
        date: j.year + '-' + pad(j.month) + '-' + pad(j.day) };
      if (!validComic(c) || (n && c.num !== n)) continue;
      goodSource = k;
      return cache[c.num] = c;
    } catch {}
  }
  return null;
}

function randNum() {
  if (!S.latest) return FALLBACK.num;
  let n; do n = 1 + Math.floor(Math.random() * S.latest); while (n === 404 || (S.comic && n === S.comic.num));
  return n;
}

async function go(k, p) {
  if (S.loading || now() < navOk) return;
  const cur = S.comic ? S.comic.num : 0, who = p ? p.name : 'xkcd';
  let n, label;
  if (k === 'first') { n = 1; label = '|<'; }
  else if (k === 'prev') { n = cur - 1 === 404 ? 403 : cur - 1; label = '< PREV'; }
  else if (k === 'next') { n = cur + 1 === 404 ? 405 : cur + 1; label = 'NEXT >'; }
  else if (k === 'last') { n = 0; label = '>|'; }
  else if (k === 'rand') { n = randNum(); label = 'RANDOM'; }
  else { n = k | 0; label = 'typed #' + n; }
  if (n === 404) return feed(who + ' asked for #404. Not found. (That is the joke.)');
  if (k !== 'last' && (n < 1 || (S.latest && n > S.latest)))
    return feed(who + ' tried to read #' + n + '. Randall has not drawn it yet.');
  if (n && n === cur) return;

  S.loading = 1;
  let c = null;
  for (let tries = 0; tries < 3 && !c; tries++) {
    c = await fetchComic(n);
    if (!c && k === 'rand') n = randNum(); else break;
  }
  if (mode !== 'host') return;
  S.loading = 0; navOk = now() + .7;
  if (!c) {
    feed("Couldn't load " + (n ? '#' + n : 'the latest comic') + '. Maybe go outside?');
    if (!S.comic) setComic(FALLBACK);
    return;
  }
  if (!n || c.num > S.latest) S.latest = Math.max(S.latest, c.num);
  setComic(c);
  if (p) feed(who + ' ' + (label.startsWith('typed') ? label : 'pressed ' + label) + '  →  #' + c.num + ' “' + c.title + '”', p.slot);
}

function setComic(c) {
  S.comic = c; S.alt = 0;
  strokes = strokesBy[c.num] || (strokesBy[c.num] = []); strokesNum = c.num;
  sendAll({ t: 'strokes', num: c.num, list: strokes });
  sfx('nav');
}

// ───────────────────────── host: players & actions ─────────────────────────
function addPlayer(id, name, bot) {
  const used = new Set(S.players.map(p => p.slot));
  let slot = 0; while (used.has(slot)) slot++;
  const p = { id, name, slot, bot: bot ? 1 : 0, x: rand(.1, .9), y: rand(1.02, 1.1), pen: 0, say: '', sayT: 0 };
  priv[id] = { sayOk: 0, tx: p.x, ty: p.y, move: 0, talk: rand(4, 10) };
  S.players.push(p);
  return p;
}
function dropPlayer(id) {
  const p = S.players.find(p => p.id === id);
  S.players = S.players.filter(p => p.id !== id);
  delete priv[id]; delete seen[id];
  if (conns[id]) { try { conns[id].close(); } catch {} delete conns[id]; }
  if (p && !p.bot) feed(p.name + ' left. (Their code finished compiling.)');
}
function addBot() {
  const taken = new Set(S.players.map(p => p.name));
  addPlayer('bot' + (++entN), BOT_NAMES.find(n => !taken.has(n)) || 'Bot', true);
}

function sendAll(m, except) {
  const s = JSON.stringify(m, round3);
  for (const id in conns) if (id !== except) { try { conns[id].send(s); } catch {} }
}
function feed(s, slot = -1) { addFeed(s, slot); sendAll({ t: 'f', s, c: slot }); }

function hostSay(p, text) {
  text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const pv = priv[p.id];
  if (!text || !pv || now() < pv.sayOk) return;
  pv.sayOk = now() + .4;
  const num = /^[#/]?(\d{1,5})$/.exec(text);
  if (num) return go(+num[1], p);
  if (/^\/raptor/i.test(text)) return hostRaptor(p);
  p.say = text; p.sayT = 3.5 + text.length * .05;
  feed(p.name + ': ' + text, p.slot);
  if (/^sudo make me a sandwich/i.test(text)) feed('xkcd: Okay.');
  else if (/^make me a sandwich/i.test(text)) feed('xkcd: What? Make it yourself.');
}
function hostRaptor(p) {
  if (now() < rapOk) return;
  rapOk = now() + 8; S.rap++;
  for (const q of S.players) if (q !== p) { q.say = 'RAPTOR!'; q.sayT = 2.2; }
  feed(p.name + ' released a velociraptor. Days since last incident: 0.', p.slot);
}
function hostAlt(p) {
  if (!S.comic || S.alt) return;
  S.alt = 1; feed(p.name + ' hovered over the comic for the title text.', p.slot);
}
function hostClear(p) {
  if (!S.comic || !strokes.length) return;
  strokes = strokesBy[S.comic.num] = [];
  sendAll({ t: 'strokes', num: S.comic.num, list: strokes });
  feed(p.name + ' erased the scribbles. Art is temporary.', p.slot);
}
function validPts(pts) {
  return Array.isArray(pts) && pts.length >= 2 && pts.length <= 100 &&
    pts.every(q => Array.isArray(q) && q.length === 2 && Number.isFinite(q[0]) && Number.isFinite(q[1]) && Math.abs(q[0]) < 3 && Math.abs(q[1]) < 3);
}
function hostPiece(p, pts) {
  if (!S.comic || !validPts(pts)) return;
  strokes.push({ c: p.slot, p: pts });
  if (strokes.length > MAX_PIECES) strokes.splice(0, strokes.length - MAX_PIECES);
  sendAll({ t: 'd', num: S.comic.num, c: p.slot, p: pts }, p.id);
}

function hostTick() {
  if (mode !== 'host') return;
  const t = now(), dt = .08;
  const mine = myPlayer();
  if (mine) { mine.x = me.x; mine.y = me.y; mine.pen = me.pen; }
  flushStroke();
  for (const p of S.players) {
    if (p.sayT > 0 && (p.sayT -= dt) <= 0) p.say = '';
    if (!p.bot) continue;
    const b = priv[p.id];
    if ((b.move -= dt) <= 0) { b.move = rand(2, 7); b.tx = rand(-.05, 1.05); b.ty = rand(0, 1.1); }
    p.x += (b.tx - p.x) * .08; p.y += (b.ty - p.y) * .08;
    if ((b.talk -= dt) <= 0) { b.talk = rand(9, 24); p.say = pick(BOT_SAY); p.sayT = 3; }
  }
  for (const id in conns) if (t - (seen[id] || t) > 8) dropPlayer(id);
  sendAll({ t: 's', s: S });
}

// ───────────────────────── networking ─────────────────────────
function genCode() { let c = ''; for (let i = 0; i < 4; i++) c += pick('BCDFGHJKLMNPQRSTVWXZ'); return c; }

function hostGame(offline) {
  mode = 'host'; myId = 'host';
  S = { room: '', comic: null, alt: 0, loading: 0, latest: 0, players: [], rap: 0 };
  addPlayer(myId, myName, false);
  if (offline || typeof Peer === 'undefined') {
    addBot(); addBot();
    setRoom(offline ? 'OFFLINE' : "OFFLINE (multiplayer library didn't load)");
  } else { setRoom('OPENING ROOM…'); openHostPeer(0); }
  startTicker(hostTick, 80);
  enterApp();
  go('last', null);
}

function openHostPeer(tries) {
  const code = genCode(), p = peer = new Peer(PREFIX + code);
  p.on('open', () => {
    S.room = code; history.replaceState(null, '', '#' + code); setRoom('ROOM ' + code);
    addFeed('Room ' + code + ' is open. Send someone the invite link. Reading alone is just called "reading".');
  });
  p.on('connection', onGuest);
  p.on('disconnected', () => setTimeout(() => { if (!p.destroyed) p.reconnect(); }, 1500));
  p.on('error', e => {
    if (peer !== p) return;
    if (e.type === 'unavailable-id' && tries < 5) { p.destroy(); openHostPeer(tries + 1); }
    else if (!S.room) setRoom('OFFLINE (signalling server unreachable)');
  });
}

function onGuest(conn) {
  const id = conn.peer;
  conn.on('open', () => {
    if (S.players.length >= MAX_PLAYERS) { const b = S.players.find(p => p.bot); if (b) dropPlayer(b.id); }
    if (S.players.length >= MAX_PLAYERS) { conn.send(JSON.stringify({ t: 'full' })); setTimeout(() => conn.close(), 500); return; }
    conns[id] = conn; seen[id] = now();
    addPlayer(id, 'anon', false);
    if (S.comic) conn.send(JSON.stringify({ t: 'strokes', num: S.comic.num, list: strokes }, round3));
  });
  conn.on('data', d => {
    let m; try { m = JSON.parse(d); } catch { return; }
    const p = conns[id] && S.players.find(p => p.id === id);
    if (!p || !m) return;
    seen[id] = now();
    switch (m.t) {
      case 'hi': p.name = cleanName(m.n); feed(p.name + ' joined. ' + S.players.length + ' people are now reading one comic.', p.slot); break;
      case 'c': p.x = clamp(+m.x || 0, -1, 2); p.y = clamp(+m.y || 0, -1, 2); p.pen = m.pen ? 1 : 0; break;
      case 'nav': if (['first', 'prev', 'rand', 'next', 'last'].includes(m.k)) go(m.k, p); break;
      case 'say': hostSay(p, m.s); break;
      case 'd': hostPiece(p, m.p); break;
      case 'clr': hostClear(p); break;
      case 'alt': hostAlt(p); break;
      case 'rap': hostRaptor(p); break;
    }
  });
  conn.on('close', () => { if (conns[id]) dropPlayer(id); });
}

function joinGame(code) {
  if (typeof Peer === 'undefined') return fail("Multiplayer library didn't load. Check your connection.");
  mode = 'client'; S = null; menuMsg('Connecting to ' + code + '…', true);
  const p = peer = new Peer();
  const giveUp = setTimeout(() => { if (!S && peer === p) fail('Timed out. The host may be behind a strict firewall (or at work).'); }, 15000);
  p.on('open', id => {
    myId = id;
    const c = hostConn = p.connect(PREFIX + code, { serialization: 'json', reliable: true });
    c.on('open', () => c.send(JSON.stringify({ t: 'hi', n: myName })));
    c.on('data', d => {
      let m; try { m = JSON.parse(d); } catch { return; }
      if (peer !== p || !m) return;
      if (m.t === 'full') return fail('Room is full. Eight is the maximum number of people who can agree on a comic.');
      if (m.t === 's' && m.s && Array.isArray(m.s.players)) {
        if (!S) { clearTimeout(giveUp); history.replaceState(null, '', '#' + code); enterApp(); setRoom('ROOM ' + code); }
        S = m.s; lastSnap = now();
      } else if (m.t === 'strokes' && Array.isArray(m.list)) { strokes = m.list.filter(s => s && validPts(s.p)); strokesNum = m.num; }
      else if (m.t === 'd' && m.num === strokesNum && validPts(m.p)) strokes.push({ c: m.c, p: m.p });
      else if (m.t === 'f') addFeed(m.s, m.c);
    });
    c.on('close', () => { if (peer === p) fail('The host left, and took the comics with them.'); });
  });
  p.on('error', e => {
    if (peer !== p) return;
    clearTimeout(giveUp);
    fail(e.type === 'peer-unavailable' ? 'No room "' + code + '". It may have been deprecated.' : 'Network error: ' + e.type);
  });
  startTicker(() => {
    if (mode !== 'client' || !hostConn || !hostConn.open || !S) return;
    flushStroke();
    const cur = JSON.stringify({ t: 'c', x: me.x, y: me.y, pen: me.pen }, round3);
    if (cur !== me.sent || now() - me.sentT > 2) { me.sent = cur; me.sentT = now(); toHost(cur); }
    if (now() - lastSnap > 8) fail('The host stopped responding. (Probably nerd sniped.)');
  }, 80);
}

function toHost(m) { try { hostConn.send(typeof m === 'string' ? m : JSON.stringify(m, round3)); } catch {} }

function fail(msg) {
  mode = 'menu'; S = null; hostConn = null;
  if (ticker) { ticker(); ticker = null; }
  if (peer) { const p = peer; peer = null; try { p.destroy(); } catch {} }
  $('menu').hidden = false; $('app').hidden = true;
  menuMsg(msg);
}

// A worker-driven timer keeps the host serving the room while its tab is in the background.
function startTicker(fn, ms) {
  if (ticker) ticker();
  try {
    const w = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),' + ms + ')'])));
    w.onmessage = fn; ticker = () => w.terminate();
  } catch {
    const h = setInterval(fn, ms); ticker = () => clearInterval(h);
  }
}

// ───────────────────────── local actions (host or guest) ─────────────────────────
function act(t, extra) {
  if (mode === 'host') {
    const p = myPlayer(); if (!p) return;
    if (t === 'nav') go(extra.k, p); else if (t === 'say') hostSay(p, extra.s);
    else if (t === 'clr') hostClear(p); else if (t === 'alt') hostAlt(p); else if (t === 'rap') hostRaptor(p);
  } else if (mode === 'client') toHost(Object.assign({ t }, extra));
}

function flushStroke() {
  if (draw.pts.length < 2) return;
  const pts = draw.pts; draw.pts = [pts[pts.length - 1]];
  if (mode === 'host') { const p = myPlayer(); if (p) hostPiece(p, pts); }
  else {
    const p = myPlayer();
    if (p && S.comic && strokesNum === S.comic.num) strokes.push({ c: p.slot, p: pts });
    toHost({ t: 'd', p: pts });
  }
}

function setPos(e) {
  const r = img.getBoundingClientRect();
  me.x = clamp((e.clientX - r.left) / (r.width || 1), -1, 2);
  me.y = clamp((e.clientY - r.top) / (r.height || 1), -1, 2);
}
stage.addEventListener('pointerdown', e => {
  if (mode === 'menu') return;
  initAudio(); setPos(e);
  if (!penOn || e.button !== 0 || draw.id !== null) return;
  draw.id = e.pointerId; draw.pts = [[me.x, me.y]]; me.pen = 1;
  try { stage.setPointerCapture(e.pointerId); } catch {}
});
stage.addEventListener('pointermove', e => {
  if (mode === 'menu') return;
  setPos(e);
  if (e.pointerId !== draw.id) return;
  const last = draw.pts[draw.pts.length - 1];
  if (Math.hypot(me.x - last[0], me.y - last[1]) > .004) draw.pts.push([me.x, me.y]);
});
const penUp = e => {
  if (e.pointerId !== draw.id) return;
  if (draw.pts.length === 1) draw.pts.push([draw.pts[0][0] + .002, draw.pts[0][1]]);   // a dot
  flushStroke(); draw.id = null; draw.pts = []; me.pen = 0;
};
stage.addEventListener('pointerup', penUp); stage.addEventListener('pointercancel', penUp);

addEventListener('keydown', e => {
  if (mode === 'menu' || e.target.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'ArrowLeft') act('nav', { k: 'prev' });
  else if (e.key === 'ArrowRight') act('nav', { k: 'next' });
  else if (e.key === 'r' || e.key === 'R') act('nav', { k: 'rand' });
  else if (e.key === 'Enter' || e.key === '/') { e.preventDefault(); $('say').focus(); }
});

// ───────────────────────── sound ─────────────────────────
function initAudio() { if (!audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch {} } }
function beep(freq, dur, type = 'square', vol = .04, slide = 0) {
  if (muted || !audio) return;
  const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
  o.connect(g).connect(audio.destination); o.start(t); o.stop(t + dur);
}
function sfx(k) {
  if (k === 'nav') beep(440, .12, 'triangle', .06, 300);
  else if (k === 'pop') beep(700, .06, 'square', .025, 200);
  else if (k === 'roar') beep(90, .7, 'sawtooth', .08, 90);
}

// ───────────────────────── drawing primitives (wobbly, like the source material) ─────────────────────────
let boil = 0, sd = 0;
function jit(amp) { const x = Math.sin((sd += 7.13) * 12.9898 + boil * 78.233) * 43758.5453; return ((x - Math.floor(x)) * 2 - 1) * amp; }
function wl(x1, y1, x2, y2, amp = 1) {
  ctx.beginPath(); ctx.moveTo(x1 + jit(amp), y1 + jit(amp));
  ctx.quadraticCurveTo((x1 + x2) / 2 + jit(amp * 1.5), (y1 + y2) / 2 + jit(amp * 1.5), x2 + jit(amp), y2 + jit(amp));
  ctx.stroke();
}
function wc(x, y, r, fill) {
  ctx.beginPath(); ctx.ellipse(x + jit(.5), y + jit(.5), r + jit(.6), r + jit(.6), 0, 0, 6.3);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  ctx.stroke();
}
function txt(s, x, y, px, al = 'center', col = '#000', halo) {
  ctx.font = px + 'px ' + HAND; ctx.textAlign = al;
  if (halo) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 3.5; ctx.strokeText(s, x, y); }
  ctx.fillStyle = col; ctx.fillText(s, x, y);
}
function wrap(s, max) {
  const lines = []; let line = '';
  for (let w of s.split(' ')) {
    while (w.length > max) { if (line) { lines.push(line); line = ''; } lines.push(w.slice(0, max)); w = w.slice(max); }
    if ((line + ' ' + w).trim().length > max) { lines.push(line); line = w; } else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line);
  return lines;
}
function bubble(s, x, y, maxW) {
  const px = 15, lines = wrap(s, 26);
  ctx.font = px + 'px ' + HAND;
  const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 16, h = lines.length * (px + 2) + 10;
  const bx = clamp(x - w / 2, 2, Math.max(2, maxW - w - 2)), by = Math.max(2, y - h - 9);
  ctx.fillStyle = '#fff'; ctx.fillRect(bx, by, w, h);
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
  wl(bx, by, bx + w, by, .8); wl(bx + w, by, bx + w, by + h, .8); wl(bx + w, by + h, bx, by + h, .8); wl(bx, by + h, bx, by, .8);
  ctx.fillRect(x - 5, by + h - 2, 10, 4); wl(x - 5, by + h, x, by + h + 8, .4); wl(x + 5, by + h, x, by + h + 8, .4);
  lines.forEach((l, i) => txt(l, bx + w / 2, by + 18 + i * (px + 2), px));
}

function drawHair(look, hx, hy, f) {
  ctx.fillStyle = '#000';
  const cap = () => { ctx.beginPath(); ctx.arc(hx, hy, 8.6, Math.PI * 1.05, Math.PI * 1.95); ctx.fill(); };
  switch (look) {
    case 1: ctx.fillRect(hx - 7, hy - 17, 14, 10); ctx.fillRect(hx - 12, hy - 8, 24, 3); break;                       // black hat
    case 2: cap(); wl(hx - 8, hy - 2, hx - 9, hy + 9, .6); wl(hx + 8, hy - 2, hx + 9, hy + 9, .6); break;            // megan
    case 3: ctx.beginPath(); ctx.ellipse(hx - 2 * f, hy - 8, 11, 4, -.2 * f, 0, 6.3); ctx.fill(); break;              // beret
    case 4: cap(); wl(hx - 7 * f, hy - 5, hx - 18 * f, hy + 3, .7); break;                                           // ponytail
    case 5: ctx.fillStyle = '#fff'; ctx.fillRect(hx - 7, hy - 17, 14, 10); ctx.strokeRect(hx - 7, hy - 17, 14, 10); ctx.strokeRect(hx - 12, hy - 8, 24, 2); break; // white hat
    case 6: cap(); ctx.beginPath(); ctx.arc(hx - 3 * f, hy - 11, 4.5, 0, 6.3); ctx.fill(); break;                     // hairbun
    case 7: cap(); wl(hx - 7 * f, hy - 3, hx - 10 * f, hy + 16, .8); wl(hx - 4 * f, hy - 6, hx - 6 * f, hy + 15, .8); break; // long hair
  }
}

// A stick figure standing next to its pointer, pointing at (px, py) with a stick in its own colour.
function drawFigure(p, px, py, t) {
  const col = COLORS[p.slot % COLORS.length], bx = px + 26, bob = Math.sin(t * 3 + p.slot * 2) * 1.5, fy = py + 64;
  const hx = bx, hy = py + 16 + bob, shy = py + 29 + bob, handX = px + 12, handY = py + 12;
  ctx.lineCap = 'round';
  for (const pass of [0, 1]) {           // white halo first, so figures stay readable on top of the comic
    sd = (p.slot + 1) * 1000;
    ctx.strokeStyle = pass ? '#000' : '#fff'; ctx.lineWidth = pass ? 2 : 6;
    wl(bx, hy + 8, bx, py + 46); wl(bx, py + 46, bx - 7, fy); wl(bx, py + 46, bx + 7, fy);
    wl(bx, shy, bx + 8, py + 43); wl(bx, shy, handX, handY);
    wc(hx, hy, 8, '#fff');
    if (pass) { drawHair(p.slot % 8, hx, hy, -1); ctx.strokeStyle = col; ctx.lineWidth = p.pen ? 4 : 2.5; }
    wl(handX, handY, px + 1, py + 1, .3);
  }
  txt(p.name + (p.id === myId ? ' (you)' : ''), bx, fy + 14, 13, 'center', col, true);
}

function drawRaptor(x, y, t) {
  sd = 311; const run = Math.sin(t * 18) * 9;
  ctx.save(); ctx.translate(x, y); ctx.scale(1.6, 1.6);
  for (const pass of [0, 1]) {
    sd = 311; ctx.strokeStyle = pass ? '#000' : '#fff'; ctx.lineWidth = pass ? 2 : 6; ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.ellipse(0, -30, 21, 10, -.25, 0, 6.3); ctx.fill(); ctx.stroke();
    wl(-18, -30, -52, -38 + run * .3);
    wl(14, -36, 26, -56); wl(20, -30, 31, -52);
    ctx.beginPath(); ctx.moveTo(24, -60); ctx.lineTo(50, -56); ctx.lineTo(48, -51); ctx.lineTo(30, -49); ctx.closePath(); ctx.fill(); ctx.stroke();
    wl(32, -49, 46, -44 + Math.abs(run) * .3);
    wl(12, -27, 20, -20); wl(20, -20, 24, -22);
    wl(-4, -22, -2 + run, -10); wl(-2 + run, -10, 4 + run, 0);
    wl(-9, -22, -10 - run, -10); wl(-10 - run, -10, -5 - run, 0);
  }
  ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(31, -56, 1.4, 0, 6.3); ctx.fill();
  ctx.restore();
}

// ───────────────────────── frame ─────────────────────────
let lastFrame = now(), frameN = 0;
function frame() {
  requestAnimationFrame(frame);
  const t = now(), dt = Math.min(.1, t - lastFrame); lastFrame = t; frameN++;
  if (mode === 'menu' || !S) return;
  boil = Math.floor(t * 7);
  syncDom();

  const dpr = Math.min(window.devicePixelRatio || 1, 2), sw = stage.clientWidth, sh = stage.clientHeight;
  const cw = Math.round(sw * dpr), ch = Math.round(sh * dpr);
  if (ov.width !== cw || ov.height !== ch) { ov.width = cw; ov.height = ch; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, sw, sh);
  const ix = img.offsetLeft, iy = img.offsetTop, iw = img.clientWidth || 1, ih = img.clientHeight || 1;

  // scribbles
  if (S.comic && strokesNum === S.comic.num) {
    ctx.lineWidth = 3; ctx.lineCap = ctx.lineJoin = 'round';
    const line = (pts, c) => {
      ctx.strokeStyle = COLORS[c % COLORS.length] || '#000'; ctx.beginPath();
      pts.forEach((q, i) => i ? ctx.lineTo(ix + q[0] * iw, iy + q[1] * ih) : ctx.moveTo(ix + q[0] * iw, iy + q[1] * ih));
      ctx.stroke();
    };
    for (const s of strokes) line(s.p, s.c);
    const mine = myPlayer();
    if (mine && draw.pts.length > 1) line(draw.pts, mine.slot);
  }

  // velociraptor
  if (S.rap !== seenRap) { if (seenRap >= 0) { raptorT = 0; sfx('roar'); } seenRap = S.rap; }
  if (raptorT >= 0) {
    raptorT += dt;
    drawRaptor(-90 + raptorT / 3 * (sw + 180), sh - 14, t);
    if (raptorT > 3) raptorT = -1;
  }

  // people
  const ppl = S.players.map(p => {
    let r = R[p.id];
    const tx = p.id === myId ? me.x : p.x, ty = p.id === myId ? me.y : p.y;
    if (!r || p.id === myId) r = R[p.id] = { x: tx, y: ty };
    else { const k = Math.min(1, dt * 14); r.x += (tx - r.x) * k; r.y += (ty - r.y) * k; }
    r.seen = frameN;
    return { p, x: ix + r.x * iw, y: iy + r.y * ih };
  }).sort((a, b) => a.y - b.y);
  for (const k in R) if (R[k].seen !== frameN) delete R[k];
  for (const e of ppl) drawFigure(e.p, e.x, e.y, t);
  for (const e of ppl) if (e.p.say) { sd = (e.p.slot + 1) * 1000 + 500; bubble(e.p.say, e.x + 26, e.y + 6, sw); }
}

// ───────────────────────── DOM sync ─────────────────────────
const dom = { comic: -1, alt: '', players: '', loading: -1 };
function syncDom() {
  const c = S.comic;
  if (S.loading !== dom.loading) { dom.loading = S.loading; $('app').classList.toggle('loading', !!S.loading); }
  if (c && c.num !== dom.comic && validComic(c)) {
    dom.comic = c.num;
    $('title').textContent = '#' + c.num + ': ' + c.title;
    img.src = c.img; img.alt = c.title;
    const link = $('permalink'); link.textContent = ' Now reading: ';
    const a = document.createElement('a'); a.href = 'https://xkcd.com/' + c.num + '/'; a.textContent = a.href;
    a.target = '_blank'; a.rel = 'noopener'; link.append(a, ' (' + c.date + ', ISO 8601, obviously).');
  }
  const altKey = c ? c.num + ':' + S.alt : '';
  if (altKey !== dom.alt) {
    dom.alt = altKey;
    $('alt').classList.toggle('hidden', !S.alt);
    $('alt').textContent = S.alt ? c.alt || '(this one has no title text)' : 'title text: ▒▒▒▒▒▒ ▒▒▒ ▒▒▒▒▒▒▒▒   (click to hover over it — for everyone)';
  }
  const key = S.players.map(p => p.slot + p.name).join('|');
  if (key !== dom.players) {
    dom.players = key;
    const box = $('players'); box.textContent = '';
    for (const p of S.players) {
      const chip = document.createElement('span'); chip.className = 'chip';
      const dot = document.createElement('i'); dot.style.background = COLORS[p.slot % COLORS.length];
      chip.append(dot, p.name); box.append(chip);
    }
  }
}

function addFeed(s, slot = -1) {
  const li = document.createElement('li');
  if (slot >= 0) { const dot = document.createElement('i'); dot.style.background = COLORS[slot % COLORS.length]; li.append(dot, ' '); }
  else li.className = 'sys';
  li.append(String(s).slice(0, 200));
  const ul = $('feed'); ul.prepend(li);
  while (ul.children.length > 60) ul.lastChild.remove();
  sfx('pop');
}

// ───────────────────────── UI glue ─────────────────────────
function menuMsg(s, neutral) { $('msg').textContent = s; $('msg').style.color = neutral ? '#555' : '#c00'; }
function setRoom(s) { $('room').textContent = s; $('copy').hidden = !/^ROOM /.test(s); }
function enterApp() {
  $('menu').hidden = true; $('app').hidden = false;
  $('feed').textContent = ''; dom.comic = -1; dom.alt = dom.players = ''; seenRap = -1;
  if (mode === 'client') { strokes = []; strokesNum = 0; }
  setPen(penOn);
}
function setPen(on) {
  penOn = on; $('pen').textContent = 'PEN: ' + (on ? 'ON' : 'OFF');
  $('pen').classList.toggle('off', !on); stage.classList.toggle('pen', on);
}
function toggleMute() { muted = !muted; $('mute').textContent = 'SOUND: ' + (muted ? 'OFF' : 'ON'); $('mute').classList.toggle('off', muted); }
function readName() {
  myName = cleanName($('name').value);
  try { localStorage.setItem('xkcd-mp-name', myName); } catch {}
  initAudio();
}

$('create').onclick = () => { readName(); hostGame(false); };
$('solo').onclick = () => { readName(); hostGame(true); };
$('join').onclick = () => {
  const code = $('code').value.toUpperCase().replace(/[^A-Z]/g, '');
  if (code.length !== 4) return menuMsg('Room codes are 4 letters.');
  readName(); joinGame(code);
};
$('code').addEventListener('keydown', e => { if (e.key === 'Enter') $('join').click(); });
$('name').addEventListener('keydown', e => { if (e.key === 'Enter') ($('code').value ? $('join') : $('create')).click(); });
document.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => { act('nav', { k: b.dataset.nav }); b.blur(); });
document.querySelectorAll('.react').forEach(b => b.onclick = () => { act('say', { s: b.textContent }); b.blur(); });
$('alt').onclick = () => act('alt');
$('clear').onclick = () => act('clr');
$('raptor').onclick = () => act('rap');
$('pen').onclick = () => setPen(!penOn);
$('mute').onclick = toggleMute;
$('chat').onsubmit = e => { e.preventDefault(); const v = $('say').value; $('say').value = ''; if (v.trim()) act('say', { s: v }); };
$('say').addEventListener('keydown', e => { if (e.key === 'Escape') $('say').blur(); });
$('copy').onclick = async () => {
  const url = location.href.split('#')[0] + '#' + (S && S.room || '');
  try { await navigator.clipboard.writeText(url); $('copy').textContent = 'COPIED!'; }
  catch { prompt('Copy this link:', url); }
  setTimeout(() => { $('copy').textContent = 'COPY INVITE LINK'; }, 1500);
};

let saved = ''; try { saved = localStorage.getItem('xkcd-mp-name') || ''; } catch {}
$('name').value = saved || pick(['Cueball', 'Megan', 'Ponytail', 'Hairbun', 'Beret']) + Math.floor(rand(10, 99));
const hashCode = location.hash.slice(1).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
if (hashCode.length === 4) { $('code').value = hashCode; menuMsg('You were invited to room ' + hashCode + '. Pick a name and hit JOIN.', true); }

requestAnimationFrame(frame);
const qs = new URLSearchParams(location.search);
if (qs.has('solo')) { readName(); hostGame(true); }
})();

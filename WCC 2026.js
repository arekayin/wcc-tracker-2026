// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-gray; icon-glyph: chess-knight;

// World Chess Championship 2026 Tracker: iPhone widget for Scriptable.
// Board and clocks from the Lichess broadcast. Evaluation from Sesse only.
// https://github.com/arekayin/wcc-tracker-2026
//
// Sizes: small, medium and large home screen widgets, plus lock screen
// (rectangular and inline). Tap the widget to open Lichess's World Championship broadcast.

const TOUR_ID = 'qfkdt8mn'; // "FIDE World Chess Championship 2026" on Lichess
const LICHESS = 'https://lichess.org';
const SESSE = 'https://analysis.sesse.net';
const TOUR_URL = 'https://lichess.org/broadcast/fide-world-chess-championship-2026/qfkdt8mn';
const SCHEDULED_GAMES = 14;
const A = { short: 'Gukesh', re: /gukesh/i, letter: 'G' };
const B = { short: 'Sindarov', re: /sindarov/i, letter: 'S' };
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const CACHE_FILE = 'wcc2026-widget-cache.json';

/* ================= Data (plain JavaScript, no Scriptable APIs) ================= */

function splitPgn(text) {
  return (text || '').replace(/\r\n?/g, '\n').split(/\n\s*\n(?=\[)/).map((s) => s.trim()).filter((s) => s.startsWith('['));
}

function header(text, key) {
  const m = new RegExp('^\\[' + key + '\\s+"([^"]*)"\\]', 'm').exec(text);
  return m ? m[1] : '';
}

function moveTokens(text) {
  const body = text.replace(/^\[.*\]\s*$/gm, '').replace(/\{[^}]*\}/g, ' ').replace(/\([^()]*\)/g, ' ').replace(/\$\d+/g, ' ');
  return body.split(/\s+/)
    .map((t) => t.replace(/^\d+\.(\.\.)?/, ''))
    .filter((t) => t && !/^(1-0|0-1|1\/2-1\/2|\*|\.+)$/.test(t));
}

function normResult(r) {
  if (r === '1-0' || r === '0-1' || r === '1/2-1/2') return r;
  if (r === '½-½') return '1/2-1/2';
  return '*';
}

// Rounds (from the tour JSON) joined with players, results and moves (from the tour PGN).
function buildGames(tour, pgnText) {
  const rounds = (tour && tour.rounds) || [];
  const texts = splitPgn(pgnText);
  return rounds.map((r, i) => {
    const text = texts.find((t) => (header(t, 'BroadcastURL') + header(t, 'GameURL')).includes('/' + r.id)) ||
      texts.find((t) => parseInt(header(t, 'Round'), 10) === i + 1) || '';
    const sans = text ? moveTokens(text) : [];
    const result = normResult(text ? header(text, 'Result') : '*');
    let status = 'upcoming';
    if (result !== '*') status = 'finished';
    else if (r.ongoing) status = 'live';
    else if (r.finishedAt || r.finished) status = 'finished';
    else if (sans.length) status = 'live';
    return {
      n: i + 1, roundId: r.id, url: r.url || TOUR_URL, startsAt: r.startsAt || null,
      white: text ? header(text, 'White') : '', black: text ? header(text, 'Black') : '',
      result, status, sans,
    };
  });
}

function matchScore(games) {
  let a = 0, b = 0;
  for (const g of games) {
    if (g.status !== 'finished' || g.result === '*') continue;
    const whiteIsA = A.re.test(g.white);
    const [w, bl] = g.result === '1-0' ? [1, 0] : g.result === '0-1' ? [0, 1] : [0.5, 0.5];
    if (whiteIsA) { a += w; b += bl; } else { a += bl; b += w; }
  }
  return { a, b };
}

// Live game first; otherwise the latest game with moves; otherwise Game 1.
function pickCurrent(games) {
  const live = games.find((g) => g.status === 'live');
  if (live) return live;
  for (let i = games.length - 1; i >= 0; i--) if (games[i].status === 'finished' || games[i].sans.length) return games[i];
  return games[0] || null;
}

function nextGame(games, cur) {
  return games.find((g) => g.status === 'upcoming' && (!cur || g.n > cur.n)) || null;
}

function shortName(full) {
  if (A.re.test(full)) return A.short;
  if (B.re.test(full)) return B.short;
  return (full || '').split(',')[0].trim() || '?';
}

function positionKey(fen) {
  return (fen || '').trim().split(/\s+/).slice(0, 3).join(' ');
}

function plyFromFen(fen) {
  const p = (fen || '').split(' ');
  const full = parseInt(p[5], 10) || 1;
  return (full - 1) * 2 + (p[1] === 'b' ? 1 : 0);
}

function isScore(s) {
  return Array.isArray(s) && ['cp', 'M', 'm', 'T', 't', 'd'].includes(s[0]);
}

// Sesse scores are from White's side. Returns text, label and White's share of the bar.
function describeScore(score) {
  if (!isScore(score)) return null;
  const n = Number(score[1]);
  switch (score[0]) {
    case 'cp': {
      if (!Number.isFinite(n)) return null;
      const v = n / 100, abs = Math.abs(v);
      const side = v > 0 ? 'White' : 'Black';
      let label = 'Equal';
      if (abs >= 2) label = side + ' winning';
      else if (abs >= 0.9) label = side + ' better';
      else if (abs >= 0.3) label = side + ' slightly better';
      return { text: (v > 0 ? '+' : v < 0 ? '−' : '') + abs.toFixed(2), label, share: 1 / (1 + Math.exp(-0.00368208 * n)) };
    }
    case 'M': return { text: 'M' + n, label: 'White mates in ' + n, share: 1 };
    case 'm': return { text: '−M' + n, label: 'Black mates in ' + n, share: 0 };
    case 'T': return { text: 'TB win', label: 'White wins (tablebase)', share: 1 };
    case 't': return { text: 'TB win', label: 'Black wins (tablebase)', share: 0 };
    case 'd': return { text: '0.00', label: 'Draw (tablebase)', share: 0.5 };
  }
  return null;
}

// Sesse's evaluation for exactly this FEN, or null. Never estimated.
function sesseEvalFor(fen, live, historic) {
  const key = positionKey(fen);
  for (const d of [live, historic]) {
    if (d && d.position && positionKey(d.position.fen) === key && isScore(d.score)) {
      return { score: d.score, depth: d.depth || null };
    }
  }
  return null;
}

function historyUrl(fen) {
  return SESSE + '/history/move' + plyFromFen(fen) + '-' + fen.replace(/ /g, '_').replace(/\//g, '-') + '.json';
}

function lastMoveLabel(sans) {
  if (!sans.length) return '';
  const ply = sans.length;
  const num = Math.ceil(ply / 2);
  return num + (ply % 2 ? '.' : '…') + ' ' + sans[ply - 1];
}

function fmtPoints(x) {
  const w = Math.floor(x), half = x - w >= 0.5;
  return half ? (w === 0 ? '½' : w + '½') : String(w);
}

function fmtClock(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '';
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = String(t % 60).padStart(2, '0');
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + s : m + ':' + s;
}

function fmtStart(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const day = d.toLocaleDateString([], { weekday: 'short' });
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return day + ' ' + time;
}

// Everything a layout needs, derived from the raw fetch results.
function viewModel(raw) {
  const games = buildGames(raw.tour, raw.pgn);
  const cur = pickCurrent(games);
  const score = matchScore(games);
  const rs = raw.round && Array.isArray(raw.round.games) ? raw.round.games[0] : null;
  const fen = (rs && rs.fen) || (cur && cur.status === 'upcoming' ? START_FEN : null) || START_FEN;
  const ev = cur && cur.status !== 'upcoming' ? sesseEvalFor(fen, raw.sesse, raw.sesseHistory) : null;
  const toMove = fen.split(' ')[1] === 'b' ? 1 : 0;
  let clocks = [null, null];
  let runningEndsAt = null;
  if (rs && Array.isArray(rs.players)) {
    clocks = [0, 1].map((i) => (rs.players[i] && Number.isFinite(rs.players[i].clock) ? rs.players[i].clock / 100 : null));
    if (cur && cur.status === 'live' && Number.isFinite(rs.thinkTime) && clocks[toMove] !== null) {
      clocks[toMove] = Math.max(0, clocks[toMove] - rs.thinkTime);
      runningEndsAt = raw.fetchedAt + clocks[toMove] * 1000;
    }
  }
  const next = nextGame(games, cur);
  let status = '';
  if (!cur) status = '';
  else if (cur.status === 'live') status = 'Live';
  else if (cur.status === 'upcoming') status = 'Starts ' + fmtStart(cur.startsAt);
  else if (next) status = 'Next ' + fmtStart(next.startsAt);
  else status = 'Final';
  return {
    fetchedAt: raw.fetchedAt,
    offline: !!raw.offline,
    total: Math.max(SCHEDULED_GAMES, games.length),
    cur, score, fen, ev, desc: ev ? describeScore(ev.score) : null,
    lastMove: rs && rs.lastMove ? { from: rs.lastMove.slice(0, 2), to: rs.lastMove.slice(2, 4) } : null,
    lastMoveLabel: cur ? lastMoveLabel(cur.sans) : '',
    white: cur ? shortName(cur.white) : '', black: cur ? shortName(cur.black) : '',
    clocks, toMove, runningEndsAt, status,
    url: TOUR_URL,
  };
}

/* ================= Network and cache (Scriptable APIs) ================= */

async function load(url, kind) {
  const req = new Request(url);
  req.timeoutInterval = 15;
  const out = kind === 'json' ? await req.loadJSON() : await req.loadString();
  const code = req.response && req.response.statusCode;
  if (code && code >= 400) throw new Error('HTTP ' + code + ' ' + url);
  return out;
}

async function fetchRaw() {
  const tour = await load(LICHESS + '/api/broadcast/' + TOUR_ID, 'json');
  const pgn = await load(LICHESS + '/api/broadcast/' + TOUR_ID + '.pgn?clocks=false&comments=false', 'string');
  const games = buildGames(tour, pgn);
  const cur = pickCurrent(games);
  let round = null;
  if (cur && cur.status !== 'upcoming') {
    round = await load(LICHESS + '/api/broadcast/-/-/' + cur.roundId, 'json');
  }
  let sesse = null, sesseHistory = null;
  const fen = round && round.games && round.games[0] && round.games[0].fen;
  if (fen) {
    try {
      sesse = await load(SESSE + '/analysis.pl?ims=0&unique=wccwidget' + Math.floor(Math.random() * 1e9), 'json');
    } catch (e) { sesse = null; }
    if (!sesseEvalFor(fen, sesse, null)) {
      try { sesseHistory = await load(historyUrl(fen), 'json'); } catch (e) { sesseHistory = null; }
    }
  }
  // Keep only what the widget uses, so the cache stays small.
  const slim = (d) => (d && d.position ? { position: { fen: d.position.fen }, score: d.score, depth: d.depth } : null);
  return { fetchedAt: Date.now(), tour, pgn, round, sesse: slim(sesse), sesseHistory: slim(sesseHistory) };
}

function cachePath() {
  const fm = FileManager.local();
  return fm.joinPath(fm.documentsDirectory(), CACHE_FILE);
}

function readCache() {
  try {
    const fm = FileManager.local();
    const p = cachePath();
    return fm.fileExists(p) ? JSON.parse(fm.readString(p)) : null;
  } catch (e) { return null; }
}

function writeCache(raw) {
  try { FileManager.local().writeString(cachePath(), JSON.stringify(raw)); } catch (e) { /* ignore */ }
}

/* ================= Drawing ================= */

const INK = Color.dynamic(new Color('#141414'), new Color('#ececec'));
const MUTED = Color.dynamic(new Color('#8a8a8a'), new Color('#8c8c8c'));
const BG = Color.dynamic(new Color('#ffffff'), new Color('#1b1b1b'));
const SQ_LIGHT = new Color('#dedede');
const SQ_DARK = new Color('#ababab');
const LAST = new Color('#000000', 0.16);

function drawBoard(fen, lastMove, px) {
  const sq = px / 8;
  const ctx = new DrawContext();
  ctx.size = new Size(px, px);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const rows = (fen || START_FEN).split(' ')[0].split('/');
  const files = 'abcdefgh';
  const hl = lastMove ? [lastMove.from, lastMove.to] : [];
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r] || '8') {
      const n = /\d/.test(ch) ? +ch : 1;
      for (let k = 0; k < n; k++, f++) {
        const rect = new Rect(f * sq, r * sq, sq, sq);
        ctx.setFillColor((r + f) % 2 ? SQ_DARK : SQ_LIGHT);
        ctx.fillRect(rect);
        if (hl.includes(files[f] + (8 - r))) { ctx.setFillColor(LAST); ctx.fillRect(rect); }
        if (!/\d/.test(ch)) ctx.drawImageInRect(pieceImage(ch), rect);
      }
    }
  }
  return ctx.getImage();
}

const pieceCache = {};
function pieceImage(ch) {
  const key = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase();
  if (!pieceCache[key]) pieceCache[key] = Image.fromData(Data.fromBase64String(PIECES[key]));
  return pieceCache[key];
}

function drawBar(share, w, h) {
  const ctx = new DrawContext();
  ctx.size = new Size(w, h);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  ctx.setFillColor(new Color('#2a2a2a'));
  ctx.fillRect(new Rect(0, 0, w, h));
  if (share !== null) {
    ctx.setFillColor(new Color('#f2f2f2'));
    ctx.fillRect(new Rect(1, 1, Math.max(0, (w - 2) * share), h - 2));
  } else {
    ctx.setFillColor(new Color('#9a9a9a', 0.5));
    ctx.fillRect(new Rect(0, 0, w, h));
  }
  return ctx.getImage();
}

/* ================= Layouts ================= */

// iOS centres content in stacks, so every line is its own row with a trailing spacer.
function line(stack) {
  const row = stack.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  return row;
}

function text(stack, str, font, color, opts = {}) {
  const t = stack.addText(str);
  t.font = font;
  t.textColor = color || INK;
  t.lineLimit = opts.lines || 1;
  if (opts.scale) t.minimumScaleFactor = opts.scale;
  return t;
}

function leftText(stack, str, font, color, opts) {
  const row = line(stack);
  const t = text(row, str, font, color, opts);
  row.addSpacer();
  return t;
}

function clockRow(stack, vm, side, size) {
  const row = line(stack);
  const name = side === 0 ? vm.white : vm.black;
  text(row, (side === 0 ? '○ ' : '● ') + (name || (side === 0 ? 'White' : 'Black')), Font.systemFont(size), INK, { scale: 0.7 });
  row.addSpacer();
  if (vm.runningEndsAt && vm.toMove === side) {
    const d = row.addDate(new Date(vm.runningEndsAt));
    d.applyTimerStyle();
    d.font = Font.semiboldMonospacedSystemFont(size);
    d.textColor = INK;
    d.rightAlignText();
    d.lineLimit = 1;
  } else {
    text(row, fmtClock(vm.clocks[side]), Font.regularMonospacedSystemFont(size), MUTED);
  }
}

function evalBlock(stack, vm, width, big) {
  const row = line(stack);
  if (vm.desc) {
    text(row, vm.desc.text, Font.semiboldMonospacedSystemFont(big ? 15 : 13), INK);
    row.addSpacer(6);
    text(row, vm.desc.label, Font.systemFont(big ? 11 : 10), MUTED, { scale: 0.7 });
  } else {
    text(row, vm.cur && vm.cur.status === 'upcoming' ? 'Not started' : 'Evaluation unavailable', Font.systemFont(big ? 12 : 11), MUTED, { scale: 0.7 });
  }
  row.addSpacer();
  if (big && vm.desc) text(row, vm.ev.depth ? 'Sesse · d' + vm.ev.depth : 'Sesse', Font.systemFont(10), MUTED);
  stack.addSpacer(4);
  const barRow = line(stack);
  const bar = barRow.addImage(drawBar(vm.desc ? vm.desc.share : null, width, 4));
  bar.imageSize = new Size(width, 4);
  barRow.addSpacer();
}

function titleRow(stack, vm, size) {
  const top = line(stack);
  text(top, 'Gukesh × Sindarov', Font.semiboldSystemFont(size), INK, { scale: 0.75 });
  top.addSpacer(6);
  text(top, fmtPoints(vm.score.a) + '–' + fmtPoints(vm.score.b), Font.semiboldSystemFont(size), INK);
}

function statusText(vm) {
  if (!vm.cur) return '';
  const g = 'Game ' + vm.cur.n;
  if (vm.status === 'Live') return g + ' of ' + vm.total + ' · Live';
  return g + ' · ' + vm.status;
}

function updatedText(vm) {
  const t = new Date(vm.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return (vm.offline ? 'Offline · ' : 'Updated ') + t;
}

function buildSmall(w, vm) {
  w.setPadding(12, 12, 12, 12);
  titleRow(w, vm, 12);
  leftText(w, statusText(vm), Font.systemFont(10), vm.status === 'Live' ? INK : MUTED, { scale: 0.8 });
  w.addSpacer();
  if (vm.lastMoveLabel) leftText(w, vm.lastMoveLabel, Font.mediumSystemFont(13), INK);
  w.addSpacer(3);
  evalBlock(w, vm, 134, false);
  w.addSpacer();
  clockRow(w, vm, 1, 11);
  clockRow(w, vm, 0, 11);
}

// Medium: board in the centre with square corners, so it never competes with the
// widget's rounded corners. Match on the left; position (clocks, evaluation) on the right.
function buildMedium(w, vm) {
  w.setPadding(12, 12, 12, 12);
  const boardPx = 130;
  const sideW = 78; // equal side columns keep the board exactly centred
  const row = w.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();

  // Left: the match.
  const left = row.addStack();
  left.layoutVertically();
  leftText(left, 'Game ' + (vm.cur ? vm.cur.n : '–'), Font.semiboldSystemFont(13), INK);
  leftText(left, vm.status === 'Live' ? 'Live' : 'of ' + vm.total, Font.systemFont(10), vm.status === 'Live' ? INK : MUTED);
  left.addSpacer();
  leftText(left, fmtPoints(vm.score.a) + '–' + fmtPoints(vm.score.b), Font.semiboldSystemFont(22), INK, { scale: 0.7 });
  leftText(left, 'Gukesh–Sindarov', Font.systemFont(9), MUTED, { scale: 0.7 });
  left.addSpacer();
  if (vm.status !== 'Live' && vm.status) {
    // "Next Wed 7:30 PM" -> "Next game" / "Wed 7:30 PM", so it fits the narrow column.
    const m = /^(Next|Starts) (.*)$/.exec(vm.status);
    leftText(left, m ? (m[1] === 'Next' ? 'Next game' : 'Starts') : vm.status, Font.systemFont(10), MUTED, { scale: 0.7 });
    if (m) leftText(left, m[2], Font.systemFont(10), MUTED, { scale: 0.7 });
  } else if (vm.lastMoveLabel) leftText(left, vm.lastMoveLabel, Font.mediumSystemFont(12), INK, { scale: 0.7 });
  left.size = new Size(sideW, boardPx);

  row.addSpacer();
  const img = row.addImage(drawBoard(vm.fen, vm.lastMove, boardPx));
  img.imageSize = new Size(boardPx, boardPx);
  row.addSpacer();

  // Right: the position, lined up with the board (Black on top, White below).
  const right = row.addStack();
  right.layoutVertically();
  sideBlock(right, vm, 1);
  right.addSpacer();
  // Evaluation bar as a divider between the two players, with Sesse's number at its end.
  const evalW = 34;
  const barW = sideW - evalW - 4;
  const barRow = line(right);
  const bar = barRow.addImage(drawBar(vm.desc ? vm.desc.share : null, barW, 4));
  bar.imageSize = new Size(barW, 4);
  barRow.addSpacer(4);
  const ev = text(barRow, vm.desc ? vm.desc.text : '–', Font.mediumMonospacedSystemFont(9), MUTED, { scale: 0.7 });
  ev.rightAlignText();
  right.addSpacer();
  sideBlock(right, vm, 0);
  right.size = new Size(sideW, boardPx);
}

// Name on one line, clock under it. The side to move's clock counts down live.
function sideBlock(stack, vm, side) {
  const name = side === 0 ? vm.white : vm.black;
  leftText(stack, (side === 0 ? '○ ' : '● ') + (name || (side === 0 ? 'White' : 'Black')), Font.systemFont(11), INK, { scale: 0.7 });
  const row = line(stack);
  if (vm.runningEndsAt && vm.toMove === side) {
    const d = row.addDate(new Date(vm.runningEndsAt));
    d.applyTimerStyle();
    d.font = Font.semiboldMonospacedSystemFont(12);
    d.textColor = INK;
    d.lineLimit = 1;
  } else {
    text(row, fmtClock(vm.clocks[side]) || ' ', Font.regularMonospacedSystemFont(12), MUTED);
  }
  row.addSpacer();
}

function buildLarge(w, vm) {
  w.setPadding(14, 16, 14, 16);
  titleRow(w, vm, 14);
  const sub = line(w);
  text(sub, statusText(vm), Font.systemFont(11), vm.status === 'Live' ? INK : MUTED, { scale: 0.8 });
  sub.addSpacer();
  if (vm.lastMoveLabel) text(sub, vm.lastMoveLabel, Font.mediumSystemFont(12), INK);
  w.addSpacer(8);
  const boardPx = 216;
  const mid = line(w);
  mid.addSpacer();
  const boardCol = mid.addStack();
  boardCol.layoutVertically();
  boardCol.size = new Size(boardPx, 0);
  clockRow(boardCol, vm, 1, 12);
  boardCol.addSpacer(3);
  const img = boardCol.addImage(drawBoard(vm.fen, vm.lastMove, boardPx));
  img.imageSize = new Size(boardPx, boardPx);
  boardCol.addSpacer(3);
  clockRow(boardCol, vm, 0, 12);
  mid.addSpacer();
  w.addSpacer();
  evalBlock(w, vm, 304, true);
  w.addSpacer(4);
  leftText(w, updatedText(vm), Font.systemFont(9), MUTED);
}

function buildRectangular(w, vm) {
  leftText(w, 'G ' + fmtPoints(vm.score.a) + '–' + fmtPoints(vm.score.b) + ' S', Font.semiboldSystemFont(13), Color.white());
  const g = vm.cur ? 'Game ' + vm.cur.n + (vm.status === 'Live' ? ' · Live' : '') : '';
  leftText(w, g + (vm.lastMoveLabel ? ' · ' + vm.lastMoveLabel : ''), Font.systemFont(11), Color.white(), { scale: 0.7 });
  leftText(w, vm.desc ? 'Sesse ' + vm.desc.text : 'Evaluation unavailable', Font.systemFont(11), Color.white(), { scale: 0.7 });
}

function buildInline(w, vm) {
  const ev = vm.desc ? ' · ' + vm.desc.text : '';
  text(w, 'G ' + fmtPoints(vm.score.a) + '–' + fmtPoints(vm.score.b) + ' S' + ev, Font.systemFont(12), Color.white());
}

function buildWidget(vm, family) {
  const w = new ListWidget();
  w.url = vm.url;
  if (family === 'accessoryRectangular') { buildRectangular(w, vm); return w; }
  if (family === 'accessoryInline' || family === 'accessoryCircular') { buildInline(w, vm); return w; }
  w.backgroundColor = BG;
  if (family === 'small') buildSmall(w, vm);
  else if (family === 'large' || family === 'extraLarge') buildLarge(w, vm);
  else buildMedium(w, vm);
  return w;
}

function errorWidget(message) {
  const w = new ListWidget();
  w.backgroundColor = BG;
  w.setPadding(12, 12, 12, 12);
  text(w, 'Gukesh × Sindarov', Font.semiboldSystemFont(12), INK);
  w.addSpacer(6);
  text(w, message, Font.systemFont(11), MUTED, { lines: 3 });
  w.url = TOUR_URL;
  return w;
}

/* ================= Main ================= */

async function main() {
  let raw;
  try {
    raw = await fetchRaw();
    writeCache(raw);
  } catch (e) {
    raw = readCache();
    if (raw) raw.offline = true;
  }
  const family = config.widgetFamily || 'medium';
  const vm = raw ? viewModel(raw) : null;
  const widget = vm ? buildWidget(vm, family) : errorWidget('Could not reach Lichess. Check your connection.');
  const live = !!(vm && vm.cur && vm.cur.status === 'live');
  // iOS decides the exact timing; this is only a request.
  widget.refreshAfterDate = new Date(Date.now() + (live ? 5 : 30) * 60 * 1000);
  if (config.runsInWidget || config.runsInAccessoryWidget) {
    Script.setWidget(widget);
  } else {
    await widget.presentMedium();
  }
  Script.complete();
}

// Piece images: cburnett set by Colin M.L. Burnett (GPLv2+), via Lichess. 72 px PNGs.
var PIECES = {"wK":"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","wQ":"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","wR":"iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAMcSURBVHic7ZvPaxNBFMc//rgYhXrIZRV6KrEmxwXBeumlf4C99tpsLx68e2jx4iF48JZsKaTQkygVeg6IFhRqsB5CSUQpBROPJeBNGQ9m6pofTrI7uxvlfWBgf+S9mffdN7OT3VkQBEEQBEEQBEEQhCnjnAUfLvAQuDzifBNYG3HOB3IG/2HtvwEPgEOD/9h5AihDuTHELj+GXVT7x1GDuxjVAXAJwHEcPM87O9hut9nc3NS7w7Irozc8z8NxnD9ORrH3fZ9OpzPKLnF8QLmuq4IcHBwEr2QF2Ogrvj5fr9dVP1HsXdfVduWowdnIoKFkMpngrjf6lwO/tWJvCxsCqWEH8/k8xWKRVqv1V+NCocD8/Lx1e1vYEGjkndD3/UiOw9ordXbNIt+lz0d18L9jI4PmABqNBouLixbcRafRaOjNuXRb8ovPE8xnki6fogZnI4PWgKfAVYClpSUWFhYsuJ2c/f19arWa3j013f2S5DpwrK9cqVQamNfETalUCmbOca9NU0VqIq2vr/d3q6kTR3Md+JjimNMEnDHaOTY2/s334wBHs7OzM8vLy6ysrMRQxW92dnbY3d3l5OTkFLgJfI21QkscAsrzvNi7V7FY1NnzPo5A4poo/ojJb+J1ykzagAhkQAQyIAIZEIEMiEAGRCADIpABEciACGRABDIgAhkQgQyIQAZEIAMiUEq0U3ge/SWOQOJY3XFHPzhfXV2N/Zn09vY21WoV4BpwG3gTa4URuQAcASqbzaputxv7M+lut6uy2azOog8xvYiwxn2d8tVqNXZxNFtbW8Gudi9tEUbxYgrexevyzFZQNtNRWfRlAyuxWR+kc7ncwILMpOh0OsYVaWmiAFWpVBIbe/opl8vBbmYFmSgaEIEMhB2DCsDdYfZ7e3u02+3oLQtBvV4P7m4Etr8Dz3tztER4OQW38klLbYy4BgibQVfofX6Qy5m+RUmXVqulP0uYSbLeelLLW6ISWB7zLkygMkgbCNvFFL0Budls2m2RZdKaOL6egkF30vIqTKBhM+gRcCukbVq8TbsBgiAIgiAI/xI/AcxvGEo58lz7AAAAAElFTkSuQmCC","wB":"iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAe4SURBVHic7ZttTFTLGcd/COjiLiz0XpBdDJRbqEBQuxeK0tJowZSmX6yp0SZtYv3QNNVGi34QqSbGDyXRpDFErJI0aZtUQJOqTZumsVVLaA1gimipvIhZicuq1LK7LkV5m37ozPbwtuxe9nCk7i+Z5Jyzc2ae579z5pmZMweiRIkSJUqUKP+nxBhtgIZPA9vl8S1g0GB73hk+An4PiFnpBpBltHFG8yng1TziqPRP4AOjjTSSRkBYLBZx8eJF4Xa7hdvtFvX19cJsNiuRfmm0kUaxChgDRF1dnZjNmTNnlEB+o400ihzABFBUVDTnx5KSEnVoBrKX2bYARgr0Uh28evVqzo8jIyPa0+fLZNM7Rz8gKisrxdTUVODxmpycFBUVFeoR+4eRBho9DtoDNANUVFRQVlYGQEtLC7dv31Z5vi5D/nvLz4KE+XqjjYs1uO5vAruB9AXyxAEe4JEU7L3hI+CetrVkZmaK+vp6cf78eZGZmTm7JbUDnzHa6OXiu3JsIwBRXFwsmpubZ3TSU1NTorm5WRQVFWlFeg18x2jj9SQZ+I1y2Gw2i4aGhjkDxNlcunRJrF27VitUM2A12plI8wXArZx0OBxiYGBgUXEUfX19wuFwaEUaBMqMdipSfAxMACI2NlbU1NSIiYmJkMVRTExMiOPHj4tVq1YpkSaATUY7t1RMwID65y9cuBBUhMuXL4umpqageerq6rQt6RGw2mgnl0K9cmbfvn1BHR8cHAw47nK5gubdv3+/VqSfGO3kJ+UryomSkhIxPj4e1OmOjo6A0/fu3Quad3x8XGzdulXln9asRK4o2gFhs9nEy5cvgzocrkBCCPHixQtht9vVPS16ORGnU7npwOcBTp48SWpq6ryZGhsb6e3tBWBoaChwvaGhAZvNBkB+fj579+6dc29aWhrHjh3j8OHDyIj2gVydXBH8EBAxMTHC7XbP2wJcLtdC8685aaEyhoaGtPm+b7TT4dACiLKysqD9SG5u7qLiFBQUBO2/tmzZovL+yWinQ8WsnDt37tyifYki3D5IcfbsWa2g5kg7o8eKYrI6KCws1KH4mWzevFl7mhTp8vUQaI06MJlMId8UG/u/lZe4uNBjx6w6Ij5o1COKBQRKSEgI+abCwkJycnJYvXo1BQUFoVe2Zo32NOIC6dqCBgYGQr4pPj6e/v5+uru7iY+PD/m+x48fa09XhECPgTcAN27ov5R8/fp1dTgq530rgsuAsFqtYnJyMuSIFC5v374VCQkJKoL93Ginw6FShd6amhrdBKqurtaG+C8b7XS4tCrjr169GnFxmpqatOLoNhfTkzTABYj4+Hhx5MgR4fP5liyMz+cThw4dEnFxcdrVxfknexFA7xeHHwN/Ue/gLRYLO3bsmD24C5nOzk5u3bqF3x/YzzAGlAJdEbR52ckBfhXqxDSM9Ivl2NSwHK+es4BOIAXZiubbzbEY09PTdHV14fP51KVhwCEf4xVNl/rXT506teQ+6MSJE9pW1Gm0c0tlv3KmtrZ2yeIoTp8+rRXp20Y7uRQ6ALFx48aIiaPIy8tTAt3V0wG9llwVxQDbtm3jzp07ES14+/bt9PT0AGyNaMHLiEOHyLVQ2qiXE3puwduiY9mzKdWrYD0fsTSA9PR0Ghsbdalgz549DA8PB+rSAz0Fegjw/PlzpqenKS8vj2jhN2/eVOIAPIho4cvEem0/cfDgQdHR0bHk6NXW1iYOHDgwuw+y6eWE3iPpcrk2tE5dWL9+PaWlpeTl5ZGfn09WVhbJycmkpKRgs9kYGxvD4/EwMjKCx+PB6XTS09PDo0ePuHv3Li7XjIHzc+Bb8uOXFcuHwE8BbwSj1ogs80OjnYs0u4ALcooQrih/k7tFdi6nwZF8xJKBRMCiSVaZkmRKll/4pMjI88UQy26Vk9N/ydbjkS3SJ5NX7nv0y72MfpnHEDLldpMzciVvaKmPjMlkErt27RLd3d3i4cOHYufOncJkMkXiURySNp6T/WHYhNuCzgMHP0lFitzcXLKzs8nKyiIvL4+ysjLthyszaGtro7W1ld7eXpxOJ06nk/7+/qVU/3egVgaOkAhVoCTgt8CX1IWSkhISEhJITU1lw4YNWK1WkpKSSExMJDExEavVisViCZwnJiZiNgd/de71egGwWoNvYh0dHeX169eB5Pf78Xq9gXOfz4fH46Gvr4/h4WGePn2K0+nUFlEP/CAUx0MRKAX4o1w+paqqiqNHj5KRkRHI8ObNG3w+Hz6fD6/Xi9/vRwgBgNlsxm63z8iPHEC63W5cLhdPnjyhvb2da9euAbB7926Ki4vJzs4mIyMDu93OunXrZtz/7Nkz3G43o6Oj/3UkJgaLxRL4o9LSZg6ur1y5Qm1tLffv31eXfg18IxIC1QLVAJWVlVRXV+N0Ouns7OTBgwd0dXXN/nTpnSE1NZXCwkI2bdqEw+HAbrdTVVVFd3e3yvIj4MfByghFoK8Bv4uIxQvTAfxVM+DbISegxTrX+1XgD8EyhNoHlcvxywbNtcdyDuQGXshQ65HJN08ZAvi3TKOa48U+ubQAa+Xen7WaNJ/taiih0jq5HfBz8vsQRS/wPeDPizkebhSzA5+VY5GV9qpls+xPe97nLxijRIkSJUqUKFFC5T9AeeCP8VzAdQAAAABJRU5ErkJggg==","wN":"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","wP":"iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAATjSURBVHic7ZvNS2NXGMafZIzWb5O0+G1s0qZ0qlMYhKobFb8WZWAcaKWttMUsVHDnX1Ek6aabLroZ3QgyrVAUF1WCcTEwLUOptCANNbFNAn6Pugji2819h9NMMzG5596TlvsD4VxInvu+j++559xzTgALCwsLCwsLCwsLCwsLiyLDpjoAjfsA3gXQAYAA/ALgZwDfqQ5MNW9qRlCWv6cA3lIZoMoKGgPwiC88Hg/6+/sBABsbG4jH4+Jn7wNYURCjMhoBnAIgr9dLa2trlMnKygp5vV6upFMATaqDNpNNAORyuejw8PAFc5iDgwNyu91s0g+qgzaLd/gZs7S0lNUcZnFxUXwm+VUHbwafAiC73U7pdDqnQRcXF6JBH5kdrN3sGwLoBAC/3w+Hw5HzwxUVFfD5fHx5x+DYXkCFQacAcHJycuMvnJ2dcfOZQTEVFR9wl0mlUjm72P7+vtjFHqgO3gycAM4A0NzcXE6DZmdn2ZwjAJWqgzeDDgB/clVsb29nNWdra0usnn0At1UHbzTvA7jgpEdHRykej2c1KBaL0cjIiGjSOYAR1UkYxR0AlwCotLSUgsFgzu7FBINBcjgcbNKz/2MlvQogxpUQiURubA4TDofFSvoDwGuqk5LJV5zc8vJy3uYwCwsLoklfqk5KFre0EYj6+voKNofp7e1lg5JmrEaYMVG8rQ3tCAQCusUEjXrVa0WyeMDdIpFI6K6gWCwmdrN7RgdvRgW9AQBVVVVoaGjQLdba2oqysrJ/aBuJGQa1AEB7e7s0Qa/Xy802aaJZMMOgQwA4OjqSJnh8fMxNeaJZMMOgvwAgkUiAiHSLXV1dIZVK8eW+bsEcmGHQYwAgIkQiEd1i4XBYNPqxbsEi4XcAND4+rnsUGxsb4xHsV9VJyWTqJm/vudjc3BSH+EnVScnmKW/zFDIfisfj1NbWxub8qDoZI+jj/77f73/pMkcme3t75PP5xOrpVZ2MEdwD8Bsn6Xa7aX19Pac5q6ur5HK5RHN2tHUlU7hlwj1qAHwN4Att2QONjY2YmprCwMAAXC7XS79st9tRUlKC3d1dnJ+fQ1vm+FibJG4ASJuQg2HUiocTnE4nhUKhvJ8/RESXl5cUCoWorq5OrKYnAKpVJ1koFVoCBICGhoYomUwWZI5IIpGgwcFB0aRtAK+oTrYQHnESMzMzuo0Rub6+psnJSdGkh6qTzZfPOPjp6Wmp5ogEAgGl29KF0s47F93d3YaZw3R1dbFBZ9q9i54VAFRdXZ3XXKdQotEoVVZWsknfqk4+F91c8vls6+hlfn7+PzOJ/AkAeTyeGx1tkUU6nabm5uaifw0ZzOdglGwyDlr1qTbj33gIgJqamkw3h7Shv6WlhQ36RlZSshbMKrVjLVK2dgrBZrNhYmKCLz8stsnj51ze0WhUSQUREe3s7Ijd7BPVpogsAaCenh5l5jDCvGhRRmKyuthdABgeHpYkVzhCDHdl6MkwqJw38Do7OyXI6UOI4W3thVkXMgx6jxsdHR0S5PSREYPuKpJh0Ovc8Hg8EuT0kRGD7nczGQbVQhtmy8vLJcjpo6amBnb787Rq9epJM6i+vl6ClBycTic3dRtUojsaLYhkMgmbrVh+n/ecOr0CMiqomM8uV+kVkFFB3wNISNAxgieqA7CwsLCwsLAoWv4GT+AWY3XKu5oAAAAASUVORK5CYII=","bK":"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","bQ":"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","bR":"iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAALNSURBVHic7doxaBNRHMfxr1IaqkNLxkC7BCKtVgu2Dgbq4FyIVNCpUCjp4uDSQcwgDmkXB8FJQkrRRYNICHQUoUIcYtFCjclSaAeHQgoFDS3SuFgopeGfvvvfJZX/BzLkkve/937cvXskD4wxxhhjjDHGmA5zTqHGdeApcLHJ5xVgtslnL4GYUN+1/S/gMfBVqO+750BDeF06od1QC+28tn/mdXDnvRYAelr4zklX14VTnMO1fbOrumVdXgu0aBb4eexYJMD2zoIKKNnm9s40brGGQo2OpRGQxpPQL577phHQf01jDjpIJpP09fUplNJTq9XIZDKeb3/PAY2MjPSk02mvZXyxsrLSValUPNXQmD+ujY6OvgqFQsMKtdTU6/W11dXVe8CPdvcFoBt4e4qVsd+v1//65Jn2E+gRkO7t7WV6eprubpU+ivb398lms+zu7h72YUGrtvZCcR74Pj4+/j6VSgX6+K9WqwfLy8sJoKBZ169BrI+NjQ0FdQXt7e1RKpXWgSuBnFDBlzbMOyU/BmILRYEFJLCABBaQwAISWEACC0hgAQksIIEFJLCABBaQwAISWEACC0hgAQksIIEvmxfC4XBkamoq0B/tl5aWIjs7O+q1/fhNOh6Pxz/l83kfSjc3MTFBsVi8CRQDPbGDtTb+H/ZNezDat9jDRCIxHItJ2w79US6XrxYKhQfAC62amrdYDrhbrVYJh8OKZVu3vb3N4OAgwBvgvkZNzYAaAAMDA/T39yuWbd3m5iZbW1uHb1XGph5QB1EZm62DBBaQwAISuD7mLwN3jrafmZlhYUFt14knc3NzLC4uPjly6A/wDiiftpbrRPYRuHX0QDQaZXJy0rGcrlwux8bGxvHDH4DbQfWh1AG7yALZ/eE6B3Xy3mhVNkkLXAPqtEWhb1wDqiv3Iwi/XRq5PubngRuObdvlc7s7YIwxxhhzlvwFzxsqeT538acAAAAASUVORK5CYII=","bB":"iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAARsSURBVHic7ZtNaGNVFMd/Mx38oGqjTtrnZMDaFqUUbRsQHR1BB1HiQkkIIiJFF1aY1SzFlYrgQtDV6Eoo2ciAtNSNGxH8QvxgSrAYH01SKKQzIUmnYzuMEtK48L4a6jTv5uWe3Km+HxzyUl7OPeff9+499777ICQkJCQkJOQ/yiHbAbQwDDyujr8E1izHc90wAnwONPfYInC37eBscwdQu4Y4nlWBO20HaZNP2ojjWcZ2kLY4DFzVEGjbdqC2uFdDHM/usR2sDSIdCHSz7WBtsaIhzq+2g7TJ8xoCPWc7SNt83Eacs7aD67Pc9gtAGnD2OecIsAnklGD/G0aAnzvopH8ERm0H3SteVbWNrjiebQEv2w5ekgjwWQBh9to5YMB2MqZ5BLhgQBzP1oCTtpMyRRyoGxTHszrwgO3kuuUmoKCbdCqVaiaTyU5EygE32E6yG87qJhuLxZrVarVZrVabjuN0ItL7kgkcFvT9FHBa9+RoNLp7PDQ01Ek7Z1pWIo0jKdA7gr5bOQS8LeX8iJBfB3jQ76RUKsXY2NjfP3D+KaZnZmYol8sArKyssLCw4OfqpFp5rHUZ97+QWrQ/A3zQ7gTHcVheXtZyNjExsStYG04DH3UQoxZSt1jK74RarUahUPB15LouGxsbOm2mNWOzTn+QumZqamp3FJucnAxaG/WbTkbiCooI+NTlNtMOJQS6MciPdnZ2do8bjUbQto0XjRKjWCCBcrkcxWKRer2O67pB2z4QVfWUwLxL1yZsJ6/DLZrPu0zbtpr7GUWiD9oGfCs7AT4F/rDQbiCetnAFPWE76U75tofifG072SAMAqUeiLMGRDXiCYT0Bqo48J3XeabTaUZGRrpymM/nmZ+f975eBU4AWQOxXpNe7DAbA96KxWIvZrNm8hgfH6dSqWSAN4FVI073QWq5o5U6kCiVSmQyGUZHu3u85boulUoFIAG8YSpIm2QF+58l28l1yys96KRfsp1kN/zUA4G+l0xAtJOOxWLN4eFhySZYXV1lfX1dLA+xTjqRSEzPzc3R1ye7gaTRaDA7O3v/4uLiLxL+xZ5quK77kJTvvWSz2RNSvsWuoGKxOBiPx5G+xfL5POVyeVC0ESGSPZyLPWs72SAc76FAd9lONiingIuCwlxQbRxojqoHepcNCnNJ+TxqOznTJIEP1RShU1HOq90iPd0WbLLAGgBuVWvSng2oZ1XeZ0S94XO7WsN5TMPvn8AP6s2fDXX1bKor8ndlm8AVtdy7pT4vm0gqiEDH1HsWzwAPq92nx0wEI0BJbeBaAualVx771YaEXo1MErakbnPjjGq+V3FQ7D2T4kQ72Wd4gOycKYHevQ6SkTLfFUmdudg3wOtmtN6X82px/ws1cDwJPApMC7fruyKpO4qdUvXLfS1/K6jl1HWgrIbaTTUMX9HwuaWq7JLPeceBIVVC+NGvSoiIMkdNQyb3vOvhAq8BX/k57HSY94b4S5KPWoSYVvXYb+ofExISEhISEhIS0oa/AMIawAAFaUP2AAAAAElFTkSuQmCC","bN":"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","bP":"iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAJZSURBVHic7Zu/alRBFIc/owTNJsYXCCgBTZE0m0KxsbBKlSJYiPmD7Dv4AL6BRUpBfACDYGkl2Ei00EAKsUkTWVBQMRpBtJkBEZLN7pw/cy/ng1OkuL8983FyuXN3FoIgCIIgCIIgCIKgMk55N5DoAV1gJv29B7wCHjv35c5d4Avw54j6DNzxbtKL+8eI+b/ueTdrzeIQcnLNezdtyYsRBD33btqKuRHk5Lpk3eyY9QcC6wXXrgr2cSI8BC04XTsSHoJ+O107Eh6Cdp2ubQwLBTfpK9bNekzQ2fT0PCyfgCmFfqpiuWB6ci17L0KLLnAgIOggZbWKMeCDgJxc751uD2qsCsrJtea9KClOC0/Pv1N0xntxEnQV5ORa1G7e4v9Y89llTjEbjATNKmZfVswGI0HjDc0GI0GHitk/FbMhBA3GQtCOYvY7xWwzxgd8tVOy5WjFPegXsKmQ+yBlt4IJoC84Pf2U2Sp6goJ6Vk1b7oj7wEeBnH2hnGo4DzxSuEk/BCa9F1fKNPBWcbO63eTXsBNpAVpycr1M77kbxxMDObkad45ow1BOrtveiz4pF4HvDoK+ps+unqcOcnJteS9+ENcc5eS67i3hON5UIOi1t4SjuFmBnFw3pBYludXYEMwqpeSQlgod4EcFk5Prm9TDo9QE3arsaXYSWJEIkhK0JJQjiUhPUoJqPG0h0pPEbzXOpffDNdIp7U1igq4KZGhRPEUSgswPdw9B8d5MQtC0QIYWxb2FoAG0XdCF0gAJQR2BDC2KX+pLHGF7lr6KqZFt7waCIAiCIKiWv5H5X754r1/zAAAAAElFTkSuQmCC"};

if (typeof process !== 'undefined' && process.versions && process.versions.node) {
  // Loaded by the offline tests, not by Scriptable.
  module.exports = { PIECES, buildGames, matchScore, pickCurrent, viewModel, describeScore, sesseEvalFor, historyUrl, plyFromFen, lastMoveLabel, fmtClock, fmtPoints, buildWidget, drawBoard };
} else {
  main();
}

// Popup controller: loads the cached state, renders it at once, then keeps it live
// while the popup is open. Nothing runs when the popup is closed.
import { LICHESS, MATCH, TIMING } from './config.js';
import { getTour, getTourPgn, getRoundPgn, getRoundState, discoverTourId } from './lichess.js';
import { buildMatch, pgnByRound, shortName, formatPoints } from './match.js';
import { SesseClient, evalForPly, describeScore } from './sesse.js';
import { legalPv, numberedLine, clocksAtPly, positionKey } from './pgn.js';
import { Board } from './board.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const CACHE_KEY = 'wcc2026.lichess';
const SESSE_KEY = 'wcc2026.sesse';

const state = {
  tourId: LICHESS.tourId,
  tour: null,
  pgn: {},             // roundId -> PGN text
  liveState: {},       // roundId -> {fen, clocks, thinkTime, fetchedAt} for live games
  fetchedAt: null,     // last successful Lichess fetch
  lastTourAt: 0,
  match: null,
  selected: null,      // game index; null = follow the current game
  viewPly: null,       // null = follow the latest move
  sesse: null,         // latest Sesse analysis
  sesseAt: null,
  lichessOk: null,
  sesseOk: null,
  showPv: false,
  historic: new Map(), // `${ply}|${fen}` -> Sesse history data or null
};

const board = new Board($('board'));
const sesse = new SesseClient({
  gamePattern: new RegExp(`${MATCH.playerA.pattern.source}|${MATCH.playerB.pattern.source}`, 'i'),
  onData: (data) => {
    state.sesse = data;
    state.sesseAt = Date.now();
    state.sesseOk = true;
    persistSesse();
    render();
    if (state.match && !hasLiveGame()) sesse.stop(); // nothing live: one look is enough
  },
  onStatus: (s) => {
    const ok = s === 'ok';
    if (ok !== state.sesseOk) {
      state.sesseOk = ok;
      renderStatus();
      renderEval();
    }
  },
});

/* ---------- data ---------- */

function rebuild() {
  if (!state.tour) return;
  state.match = buildMatch(state.tour, state.pgn, state.liveState);
}

function hasLiveGame() {
  return !!(state.match && state.match.games.some((g) => g.status === 'live'));
}

async function refreshTour() {
  let tour;
  try {
    tour = await getTour(state.tourId);
  } catch (e) {
    if (e.status !== 404) throw e;
    state.tourId = await discoverTourId();
    tour = await getTour(state.tourId);
  }
  const pgn = await getTourPgn(state.tourId);
  state.tour = tour;
  state.pgn = pgnByRound(pgn, tour.rounds);
  state.lastTourAt = Date.now();
}

// While a game is live, poll the small round JSON (position + clocks) and
// download the PGN only when the position or result has changed.
async function refreshLiveRounds(forcePgn = false) {
  const live = state.match.games.filter((g) => g.status === 'live' && g.roundId);
  for (const g of live) {
    const rs = await getRoundState(g.roundId);
    if (rs) state.liveState[g.roundId] = rs;
    const tip = g.plies[g.plies.length - 1];
    const changed = !rs || !tip || positionKey(rs.fen) !== positionKey(tip.fen) || rs.status !== '*';
    if (forcePgn || changed) {
      const text = await getRoundPgn(g.roundId);
      const map = pgnByRound(text, state.tour.rounds);
      if (map[g.roundId]) state.pgn[g.roundId] = map[g.roundId];
    }
  }
}

let timer = null;
let inFlight = false;

async function tick(force = false) {
  clearTimeout(timer);
  if (inFlight) return;
  inFlight = true;
  let delay = TIMING.idleTourMs;
  try {
    const live = hasLiveGame();
    const tourAge = Date.now() - state.lastTourAt;
    if (force || !state.tour || tourAge >= (live ? TIMING.liveTourMs : TIMING.idleTourMs)) {
      await refreshTour();
      rebuild();
      if (hasLiveGame()) await refreshLiveRounds(false);
    } else if (live) {
      await refreshLiveRounds();
    }
    state.fetchedAt = Date.now();
    state.lichessOk = true;
    rebuild();
    persistLichess();
    delay = hasLiveGame() ? TIMING.livePgnMs : TIMING.idleTourMs;
    if (hasLiveGame()) sesse.start();
  } catch (e) {
    state.lichessOk = false;
    delay = e.status === 429 ? TIMING.rateLimitBackoffMs : 15000;
  } finally {
    inFlight = false;
  }
  render();
  timer = setTimeout(tick, delay);
}

function persistLichess() {
  store.save(CACHE_KEY, { tourId: state.tourId, tour: state.tour, pgn: state.pgn, liveState: state.liveState, fetchedAt: state.fetchedAt });
}

let sesseSaveTimer = null;
function persistSesse() {
  if (sesseSaveTimer) return;
  sesseSaveTimer = setTimeout(saveSesseNow, 3000);
}
function saveSesseNow() {
  sesseSaveTimer = null;
  const d = state.sesse;
  if (!d) return;
  // Keep only what the popup needs.
  store.save(SESSE_KEY, {
    at: state.sesseAt,
    data: {
      position: { fen: d.position.fen, history: d.position.history },
      score: d.score, pv: d.pv, depth: d.depth, score_history: d.score_history,
    },
  });
}

window.addEventListener('pagehide', () => { if (sesseSaveTimer) { clearTimeout(sesseSaveTimer); saveSesseNow(); } });

/* ---------- view helpers ---------- */

function selectedGame() {
  if (!state.match) return null;
  const i = state.selected ?? state.match.currentIndex;
  return state.match.games[i] || null;
}

function lastPly(g) {
  return g ? Math.max(0, g.plies.length - 1) : 0;
}

function shownPly(g) {
  const last = lastPly(g);
  return state.viewPly === null ? last : Math.min(state.viewPly, last);
}

function goToPly(p) {
  const g = selectedGame();
  if (!g) return;
  const last = lastPly(g);
  const ply = Math.max(0, Math.min(last, p));
  state.viewPly = ply === last ? null : ply;
  render();
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return sameDay ? t : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${t}`;
}

function fmtStart(ts) {
  if (!ts) return 'Not started';
  const d = new Date(ts);
  return `Starts ${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function resultFor(g, colour) {
  if (g.status !== 'finished' || g.result === '*') return '';
  if (g.result === '1/2-1/2') return '½';
  const whiteWon = g.result === '1-0';
  return (colour === 'w') === whiteWon ? '1' : '0';
}

/* ---------- render ---------- */

function render() {
  renderHeader();
  renderGames();
  renderBoardAndPlayers();
  renderMoves();
  renderEval();
  renderStatus();
}

function renderHeader() {
  const m = state.match;
  const g = selectedGame();
  $('score').textContent = m ? `${formatPoints(m.score.a)} – ${formatPoints(m.score.b)}` : '– –';
  const total = m ? Math.max(MATCH.scheduledGames, m.games.length) : MATCH.scheduledGames;
  $('gameLabel').textContent = g ? `Game ${g.number} of ${total}` : `Game – of ${total}`;
}

function renderGames() {
  const nav = $('games');
  const m = state.match;
  const games = m ? m.games : [];
  if (nav.children.length !== games.length) {
    nav.textContent = '';
    games.forEach((g) => {
      const b = document.createElement('button');
      b.innerHTML = '<span class="n"></span><span class="r"></span>';
      b.addEventListener('click', () => {
        state.selected = g.index;
        state.viewPly = null;
        render();
      });
      nav.appendChild(b);
    });
  }
  const sel = selectedGame();
  games.forEach((g, i) => {
    const b = nav.children[i];
    b.className = `${g.status}${sel && sel.index === i ? ' selected' : ''}`;
    b.querySelector('.n').textContent = g.number;
    let mark = '·';
    if (g.status === 'live') mark = '●';
    if (g.status === 'finished') mark = g.winner === 'A' ? 'G' : g.winner === 'B' ? 'S' : g.winner === 'draw' ? '½' : '?';
    b.querySelector('.r').textContent = mark;
    const who = g.white ? `${shortName(g.white)} – ${shortName(g.black)}` : '';
    const what = g.status === 'live' ? 'Live' : g.status === 'finished' ? g.result.replace('1/2-1/2', '½–½') : fmtStart(g.startsAt);
    b.title = [`Game ${g.number}`, who, what].filter(Boolean).join(' · ');
  });
}

function renderBoardAndPlayers() {
  const g = selectedGame();
  const ply = shownPly(g);
  const p = g && g.plies[ply];
  board.render(p ? p.fen : null, p && p.from ? p : null);
  const top = $('topPlayer');
  const bottom = $('bottomPlayer');
  top.querySelector('.pname').textContent = g && g.black ? shortName(g.black) : '';
  bottom.querySelector('.pname').textContent = g && g.white ? shortName(g.white) : '';
  top.querySelector('.pres').textContent = g ? resultFor(g, 'b') : '';
  bottom.querySelector('.pres').textContent = g ? resultFor(g, 'w') : '';
  renderClocks();
  const link = $('broadcast');
  link.href = (g && g.url) || (state.tour && state.tour.url) || LICHESS.broadcastUrl;
  const last = lastPly(g);
  $('prev').disabled = !g || ply === 0;
  $('next').disabled = !g || ply >= last;
  $('latest').disabled = !g || ply >= last;
}

let movesKey = '';
function renderMoves() {
  const box = $('moves');
  const g = selectedGame();
  const ply = shownPly(g);
  const key = g ? `${g.index}|${g.plies.length}|${g.result}|${g.status}` : 'none';
  if (key !== movesKey) {
    movesKey = key;
    box.textContent = '';
    if (!g || g.plies.length <= 1) {
      const s = document.createElement('span');
      s.className = 'empty';
      if (!state.match) s.textContent = state.lichessOk === false ? 'Broadcast unavailable.' : 'Loading broadcast…';
      else if (g.error) s.textContent = g.error;
      else s.textContent = g.status === 'upcoming' ? fmtStart(g.startsAt) : 'No moves yet.';
      box.appendChild(s);
    } else {
      const frag = document.createDocumentFragment();
      const startBlack = g.plies[0].fen.split(' ')[1] === 'b';
      let num = parseInt(g.plies[0].fen.split(' ')[5], 10) || 1;
      for (let i = 1; i < g.plies.length; i++) {
        const whiteMove = startBlack ? i % 2 === 0 : i % 2 === 1;
        if (whiteMove || i === 1) {
          const n = document.createElement('span');
          n.className = 'n';
          n.textContent = whiteMove ? `${num}.` : `${num}…`;
          frag.appendChild(n);
        }
        const m = document.createElement('span');
        m.className = 'm';
        m.dataset.ply = i;
        m.textContent = g.plies[i].san;
        frag.appendChild(m);
        if (!whiteMove) num++;
        frag.appendChild(document.createTextNode(' '));
      }
      if (g.result !== '*') {
        const r = document.createElement('span');
        r.className = 'res';
        r.textContent = g.result.replace('1/2-1/2', '½–½');
        frag.appendChild(r);
      }
      box.appendChild(frag);
    }
  }
  box.querySelectorAll('.m.cur').forEach((el) => el.classList.remove('cur'));
  const cur = box.querySelector(`.m[data-ply="${ply}"]`);
  if (cur) {
    cur.classList.add('cur');
    // Keep the current move visible without scrolling the popup itself.
    const top = cur.offsetTop - box.offsetTop;
    if (top < box.scrollTop || top + cur.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = Math.max(0, top - box.clientHeight + cur.offsetHeight + 4);
    }
  } else if (ply === 0) {
    box.scrollTop = 0;
  }
}

function renderEval() {
  const g = selectedGame();
  const num = $('evalNum');
  const label = $('evalLabel');
  const bar = $('bar');
  const fill = $('barFill');
  const pvBtn = $('pvToggle');
  const pvEl = $('pv');
  const link = $('sesseLink');

  const ply = shownPly(g);
  const target = g && g.plies[ply];
  let ev = null;
  if (g && target && g.status !== 'upcoming') {
    const hkey = `${ply}|${target.sesseFen}`;
    const historic = state.historic.get(hkey) || null;
    ev = evalForPly(state.sesse, g.plies, ply, historic);
    const isLiveTip = g.status === 'live' && ply === lastPly(g);
    if ((!ev || ev.source === 'score_history') && !isLiveTip && !state.historic.has(hkey)) {
      state.historic.set(hkey, null);
      sesse.history(ply, target.sesseFen).then((d) => {
        if (d) {
          state.historic.set(hkey, d);
          renderEval();
        } else {
          setTimeout(() => state.historic.delete(hkey), 60000);
        }
      });
    }
  }

  const desc = ev && describeScore(ev.score);
  if (!desc) {
    num.textContent = 'Evaluation unavailable';
    num.classList.add('na');
    label.textContent = '';
    label.hidden = true;
    bar.classList.add('na');
    pvBtn.hidden = true;
    pvEl.hidden = true;
    link.textContent = 'Sesse';
    link.title = state.sesseOk === false ? 'Sesse could not be reached' : 'Sesse has no evaluation for this position';
    return;
  }
  num.classList.remove('na');
  bar.classList.remove('na');
  num.textContent = desc.text;
  label.textContent = desc.label;
  fill.style.width = `${(desc.share * 100).toFixed(1)}%`;
  link.textContent = ev.depth ? `Sesse · d${ev.depth}` : 'Sesse';
  link.title = ev.source === 'live' ? 'Live evaluation from Sesse' : 'Stored Sesse evaluation for this position';

  const pv = legalPv(ev.pvFen, ev.pv);
  pvBtn.hidden = pv.length === 0;
  pvEl.hidden = !state.showPv || pv.length === 0;
  pvEl.textContent = pv.length ? numberedLine(ev.pvFen, pv, 14) : '';
  label.hidden = !pvEl.hidden;
  pvBtn.textContent = state.showPv ? 'PV ▴' : 'PV ▾';
}

// Clocks: at the latest position of a live game they come from Lichess's round
// snapshot and the side to move counts down; anywhere else they are the [%clk]
// readings recorded in the PGN for that move.
function clockState(g) {
  if (!g || !g.plies.length) return null;
  const ply = shownPly(g);
  const tip = g.plies[ply];
  const atLiveTip = g.status === 'live' && ply === lastPly(g);
  const ls = g.live;
  if (atLiveTip && ls && ls.fen && positionKey(ls.fen) === positionKey(tip.fen) && ls.clocks.every((c) => c !== null)) {
    const side = tip.fen.split(' ')[1] === 'b' ? 1 : 0;
    const vals = [...ls.clocks];
    let running = null;
    if (ls.thinkTime !== null) {
      vals[side] = Math.max(0, vals[side] - ls.thinkTime - (Date.now() - ls.fetchedAt) / 1000);
      running = side;
    }
    return { vals, running };
  }
  return { vals: clocksAtPly(g.plies, ply, g.baseSeconds), running: null };
}

function fmtClock(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '';
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s2 = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s2}` : `${m}:${s2}`;
}

function renderClocks() {
  const g = selectedGame();
  const cs = clockState(g);
  const set = (el, i) => {
    el.textContent = cs ? fmtClock(cs.vals[i]) : '';
    el.classList.toggle('run', !!cs && cs.running === i);
  };
  set($('bottomPlayer').querySelector('.pclock'), 0);
  set($('topPlayer').querySelector('.pclock'), 1);
}

setInterval(() => {
  const g = selectedGame();
  if (g && g.status === 'live' && state.viewPly === null) renderClocks();
}, 1000);

function renderStatus() {
  const el = $('status');
  const text = $('statusText');
  const live = hasLiveGame();
  let s = 'Connecting';
  let on = false;
  if (state.lichessOk === false) s = state.match ? 'Offline · cached' : 'Offline';
  else if (state.lichessOk) {
    on = true;
    s = live ? 'Live' : 'Up to date';
    if (live && state.sesseOk === false) s = 'Live · Sesse offline';
  } else if (state.match) s = 'Cached';
  el.className = `status ${on ? 'on' : 'off'}`;
  text.textContent = s;
  $('updated').textContent = state.fetchedAt ? `· ${fmtTime(state.fetchedAt)}` : '';
  $('updated').title = 'Last broadcast update';
}

/* ---------- events ---------- */

$('prev').addEventListener('click', () => goToPly(shownPly(selectedGame()) - 1));
$('next').addEventListener('click', () => goToPly(shownPly(selectedGame()) + 1));
$('latest').addEventListener('click', () => goToPly(Infinity));
$('refresh').addEventListener('click', () => {
  sesse.kick();
  if (!sesse.running) sesse.start();
  tick(true);
});
$('pvToggle').addEventListener('click', () => {
  state.showPv = !state.showPv;
  renderEval();
});
$('moves').addEventListener('click', (e) => {
  const m = e.target.closest('.m');
  if (m) goToPly(+m.dataset.ply);
});
document.addEventListener('keydown', (e) => {
  const g = selectedGame();
  if (!g) return;
  const p = shownPly(g);
  if (e.key === 'ArrowLeft') goToPly(p - 1);
  else if (e.key === 'ArrowRight') goToPly(p + 1);
  else if (e.key === 'Home') goToPly(0);
  else if (e.key === 'End') goToPly(Infinity);
  else return;
  e.preventDefault();
});

/* ---------- start ---------- */

(async function init() {
  const [cached, cachedSesse] = await Promise.all([store.load(CACHE_KEY), store.load(SESSE_KEY)]);
  if (cached && cached.tour) {
    state.tourId = cached.tourId || state.tourId;
    state.tour = cached.tour;
    state.pgn = cached.pgn || {};
    state.liveState = cached.liveState || {};
    state.fetchedAt = cached.fetchedAt;
    rebuild();
  }
  if (cachedSesse && cachedSesse.data) {
    state.sesse = cachedSesse.data;
    state.sesseAt = cachedSesse.at;
  }
  render();
  sesse.start(); // one look at Sesse on open; keeps going only while a game is live
  tick(true);
})();


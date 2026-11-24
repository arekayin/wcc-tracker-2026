// Sesse (analysis.sesse.net) is the only evaluation source. There is no local engine,
// no fallback engine and no estimate: if Sesse has nothing for a position, the popup
// says "Evaluation unavailable".
//
// Protocol (read from Sesse's own front end, remoteglot.js, and checked live on 24 Nov 2026):
//   GET /analysis.pl?ims=<X-RGLM>&unique=<token>
//       Long poll. Replies with full JSON when ims=0 or unknown, otherwise with a
//       JSON-delta array [[keyPath, value], [keyPath]...] against the previous reply.
//       The X-RGLM response header is the ims for the next request.
//       Body: position {fen, history[SAN], player_w, player_b, result}, score, pv[SAN],
//       depth, score_history {ply: score}, engine {...}, optional games [...].
//   GET /history/move<ply>-<fen with ' '→'_' and '/'→'-'>.json
//       Stored final analysis of a past position, same shape as the live body.
// Scores are from White's point of view: ['cp', n] centipawns, ['M', n]/['m', n] White/Black
// mates in n, ['T', n]/['t', n] White/Black tablebase win, ['d'] tablebase draw.
import { SESSE, TIMING } from './config.js';
import { positionKey, stripSanDecorations } from './pgn.js';

// Apply a JSON-delta (the format of the json_delta library used by remoteglot).
export function applyDelta(root, delta) {
  let out = root;
  for (const stanza of delta) {
    if (!Array.isArray(stanza) || !Array.isArray(stanza[0])) throw new Error('Bad delta stanza');
    const path = stanza[0];
    if (path.length === 0) {
      if (stanza.length < 2) throw new Error('Cannot delete root');
      out = stanza[1];
      continue;
    }
    let parent = out;
    for (let i = 0; i < path.length - 1; i++) {
      parent = parent[path[i]];
      if (parent === null || typeof parent !== 'object') throw new Error('Delta path not found');
    }
    const key = path[path.length - 1];
    if (stanza.length === 1) {
      if (Array.isArray(parent)) parent.splice(key, 1);
      else delete parent[key];
    } else {
      parent[key] = stanza[1];
    }
  }
  return out;
}

export function isValidAnalysis(d) {
  return !!(d && typeof d === 'object' && d.position && typeof d.position.fen === 'string');
}

export function isScore(s) {
  return Array.isArray(s) && typeof s[0] === 'string' && ['cp', 'M', 'm', 'T', 't', 'd'].includes(s[0]);
}

// Text and bar position for a Sesse score. `share` is White's part of the bar (0..1).
export function describeScore(score) {
  if (!isScore(score)) return null;
  const [type, raw] = score;
  const n = Number(raw);
  switch (type) {
    case 'cp': {
      if (!Number.isFinite(n)) return null;
      const v = n / 100;
      const abs = Math.abs(v);
      const text = (v > 0 ? '+' : v < 0 ? '−' : '') + abs.toFixed(2);
      const side = v > 0 ? 'White' : 'Black';
      let label = 'Equal';
      if (abs >= 2) label = `${side} winning`;
      else if (abs >= 0.9) label = `${side} better`;
      else if (abs >= 0.3) label = `${side} slightly better`;
      const share = 1 / (1 + Math.exp(-0.00368208 * n));
      return { text, label, share };
    }
    case 'M':
      return { text: `M${n}`, label: `White mates in ${n}`, share: 1 };
    case 'm':
      return { text: `−M${n}`, label: `Black mates in ${n}`, share: 0 };
    case 'T':
      return { text: 'TB win', label: 'White wins (tablebase)', share: 1 };
    case 't':
      return { text: 'TB win', label: 'Black wins (tablebase)', share: 0 };
    case 'd':
      return { text: '0.00', label: 'Draw (tablebase)', share: 0.5 };
    default:
      return null;
  }
}

export function historyUrl(ply, sesseFen) {
  return `${SESSE.base}/history/move${ply}-${sesseFen.replace(/ /g, '_').replace(/\//g, '-')}.json`;
}

// Same game? Compare Sesse's move list with the broadcast's, ignoring +/# marks.
export function sharesHistory(sesseData, plies) {
  const hist = sesseData && sesseData.position && sesseData.position.history;
  if (!Array.isArray(hist)) return false;
  const n = Math.min(hist.length, plies.length - 1);
  if (n === 0) return false;
  for (let i = 0; i < n; i++) {
    if (stripSanDecorations(hist[i]) !== stripSanDecorations(plies[i + 1].san)) return false;
  }
  return true;
}

// Pick Sesse's evaluation for a given ply of a broadcast game.
// Returns {score, pv, pvFen, depth, source} or null. Never invents anything.
export function evalForPly(live, plies, ply, historic) {
  const target = plies[ply];
  if (!target) return null;
  const key = positionKey(target.fen);

  if (isValidAnalysis(live) && positionKey(live.position.fen) === key && isScore(live.score)) {
    return { score: live.score, pv: live.pv || [], pvFen: live.position.fen, depth: live.depth, source: 'live' };
  }
  if (historic && isValidAnalysis(historic) && positionKey(historic.position.fen) === key && isScore(historic.score)) {
    return { score: historic.score, pv: historic.pv || [], pvFen: historic.position.fen, depth: historic.depth, source: 'history' };
  }
  if (isValidAnalysis(live) && live.score_history && sharesHistory(live, plies)) {
    const hist = live.position.history;
    if (ply <= hist.length) {
      const s = live.score_history[String(ply)];
      if (isScore(s)) return { score: s, pv: [], pvFen: target.fen, depth: null, source: 'score_history' };
    }
  }
  return null;
}

function randomToken() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
}

// Long-polls Sesse while the popup is open, the same way Sesse's own page does,
// but never more often than TIMING.sesseMinGapMs.
export class SesseClient {
  constructor({ onData, onStatus, gamePattern }) {
    this.onData = onData;
    this.onStatus = onStatus;
    this.gamePattern = gamePattern;
    this.backendUrl = SESSE.liveUrl;
    this.ims = '0';
    this.raw = null;
    this.unique = randomToken();
    this.running = false;
    this.ctrl = null;
    this.historyCache = new Map();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.gen = (this.gen || 0) + 1;
    this.loop(this.gen);
  }

  stop() {
    this.running = false;
    if (this.ctrl) this.ctrl.abort();
  }

  // Abort the current long poll and ask again at once (refresh button).
  kick() {
    this.ims = '0';
    this.kicked = true;
    if (this.ctrl) this.ctrl.abort();
  }

  async loop(gen) {
    const alive = () => this.running && this.gen === gen;
    while (alive()) {
      const started = Date.now();
      let wait = TIMING.sesseMinGapMs;
      try {
        await this.pollOnce();
        this.onStatus && this.onStatus('ok');
      } catch (e) {
        if (!alive()) break;
        if (e.name === 'AbortError' && this.kicked) {
          this.kicked = false;
          wait = 0;
        } else if (e.name === 'AbortError') {
          wait = 0; // long-poll timeout: just ask again
        } else {
          this.ims = '0';
          this.onStatus && this.onStatus('error', e);
          wait = TIMING.sesseRetryMs;
        }
      }
      const elapsed = Date.now() - started;
      await sleep(Math.max(0, wait - elapsed));
    }
  }

  async pollOnce() {
    this.ctrl = new AbortController();
    const timer = setTimeout(() => this.ctrl.abort(), TIMING.sesseLongPollTimeoutMs);
    try {
      const url = new URL(this.backendUrl, SESSE.base);
      url.searchParams.set('ims', this.ims);
      url.searchParams.set('unique', this.unique);
      const res = await fetch(url.href, { signal: this.ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`Sesse HTTP ${res.status}`);
      const body = await res.json();
      let next;
      if (Array.isArray(body)) {
        if (!this.raw) throw new Error('Delta without a base');
        next = applyDelta(JSON.parse(JSON.stringify(this.raw)), body);
      } else {
        next = body;
      }
      if (!isValidAnalysis(next)) throw new Error('Unexpected Sesse response');
      this.raw = next;
      this.ims = res.headers.get('X-RGLM') || '0';
      if (this.maybeSwitchGame(next)) return;
      this.onData && this.onData(next);
    } finally {
      clearTimeout(timer);
    }
  }

  // If Sesse is analysing several games, follow the World Championship one.
  maybeSwitchGame(data) {
    if (!Array.isArray(data.games) || !this.gamePattern) return false;
    const want = data.games.find((g) => g && this.gamePattern.test(g.name || ''));
    if (!want || !want.url) return false;
    const wantUrl = new URL(want.url, SESSE.base).pathname;
    const curUrl = new URL(this.backendUrl, SESSE.base).pathname;
    if (wantUrl === curUrl) return false;
    this.backendUrl = want.url;
    this.ims = '0';
    this.raw = null;
    return true;
  }

  // Stored analysis for a past position, or null if Sesse has none (yet).
  // Hits are kept for the popup's lifetime; misses are retried after a minute,
  // because Sesse writes the file only once the game has moved on.
  async history(ply, sesseFen) {
    const url = historyUrl(ply, sesseFen);
    const hit = this.historyCache.get(url);
    if (hit && (hit.data || Date.now() - hit.at < 60000)) return hit.promise;
    const promise = (async () => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return null;
        const d = await res.json();
        return isValidAnalysis(d) && isScore(d.score) ? d : null;
      } catch (e) {
        return null;
      }
    })();
    const entry = { promise, at: Date.now(), data: null };
    this.historyCache.set(url, entry);
    entry.data = await promise;
    return entry.data;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

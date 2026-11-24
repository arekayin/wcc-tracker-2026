// Lichess broadcast API (public, no token needed). Endpoints verified 24 Nov 2026:
//   GET /api/broadcast/{tourId}                 tournament + 14 rounds (JSON)
//   GET /api/broadcast/{tourId}.pgn             every game of every round (PGN)
//   GET /api/broadcast/round/{roundId}.pgn      one round (PGN), fetched when the live game changes
//   GET /api/broadcast/-/-/{roundId}            round JSON: current FEN, clocks (centiseconds) and
//                                               thinkTime (seconds since the last move), polled while live
//   GET /api/broadcast/-/-/{roundId}            round + its tournament (JSON), for rediscovery
//   GET /api/broadcast/search?q=...             search, last-resort rediscovery
import { LICHESS, TIMING } from './config.js';

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

export async function fetchWithTimeout(url, opts = {}, timeoutMs = TIMING.fetchTimeoutMs) {
  const ctrl = new AbortController();
  const outer = opts.signal;
  const onAbort = () => ctrl.abort();
  if (outer) outer.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new HttpError(res.status, url);
    return res;
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener('abort', onAbort);
  }
}

const PGN_PARAMS = 'clocks=true&comments=false';

export async function getTour(tourId) {
  const res = await fetchWithTimeout(`${LICHESS.base}/api/broadcast/${tourId}`, {
    headers: { Accept: 'application/json' },
  });
  const data = await res.json();
  if (!data || !data.tour || !Array.isArray(data.rounds)) throw new Error('Unexpected tournament response');
  return {
    id: data.tour.id,
    name: data.tour.name,
    url: data.tour.url || LICHESS.broadcastUrl,
    rounds: data.rounds.map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      ongoing: !!r.ongoing,
      startsAt: r.startsAt || null,
      finishedAt: r.finishedAt || null,
      finished: !!(r.finishedAt || r.finished),
    })),
  };
}

export async function getTourPgn(tourId) {
  const res = await fetchWithTimeout(`${LICHESS.base}/api/broadcast/${tourId}.pgn?${PGN_PARAMS}`);
  return res.text();
}

export async function getRoundPgn(roundId) {
  const res = await fetchWithTimeout(`${LICHESS.base}/api/broadcast/round/${roundId}.pgn?${PGN_PARAMS}`);
  return res.text();
}

// Small JSON snapshot of a round: FEN, both clocks and how long the side to move has been thinking.
export async function getRoundState(roundId) {
  const res = await fetchWithTimeout(`${LICHESS.base}/api/broadcast/-/-/${roundId}`, {
    headers: { Accept: 'application/json' },
  });
  const data = await res.json();
  const g = data && Array.isArray(data.games) ? data.games[0] : null;
  if (!g) return null;
  const clk = (p) => (p && Number.isFinite(p.clock) ? p.clock / 100 : null);
  return {
    fen: g.fen || null,
    status: g.status || '*',
    clocks: [clk(g.players && g.players[0]), clk(g.players && g.players[1])],
    thinkTime: Number.isFinite(g.thinkTime) ? g.thinkTime : null,
    fetchedAt: Date.now(),
  };
}

// Find the tournament ID again if the configured one ever fails.
export async function discoverTourId() {
  try {
    const res = await fetchWithTimeout(`${LICHESS.base}/api/broadcast/-/-/${LICHESS.knownRoundId}`);
    const data = await res.json();
    if (data && data.tour && data.tour.id) return data.tour.id;
  } catch (e) {
    if (e.status === 429) throw e;
  }
  const res = await fetchWithTimeout(
    `${LICHESS.base}/api/broadcast/search?q=${encodeURIComponent(LICHESS.searchQuery)}`,
  );
  const data = await res.json();
  const hit = (data.currentPageResults || []).find(
    (x) => x.tour && LICHESS.tourNamePattern.test(x.tour.name) && !LICHESS.tourNameExclude.test(x.tour.name),
  );
  if (!hit) throw new Error('World Championship broadcast not found on Lichess');
  return hit.tour.id;
}

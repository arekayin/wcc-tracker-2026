// Turns Lichess rounds + PGN into the match model the popup renders.
import { MATCH } from './config.js';
import { splitPgn, parseHeaders, parseGame } from './pgn.js';

// Map each game in a PGN export to its round ID.
export function pgnByRound(pgnText, rounds) {
  const out = {};
  for (const text of splitPgn(pgnText)) {
    const h = parseHeaders(text);
    const url = h.BroadcastURL || h.GameURL || '';
    let id = (rounds.find((r) => url.includes(`/${r.id}`)) || {}).id;
    if (!id && h.Round) {
      // "3.1" means round 3, board 1.
      const n = parseInt(h.Round, 10);
      if (n >= 1 && n <= rounds.length) id = rounds[n - 1].id;
    }
    if (id && !out[id]) out[id] = text;
  }
  return out;
}

export function shortName(full) {
  if (MATCH.playerA.pattern.test(full)) return MATCH.playerA.short;
  if (MATCH.playerB.pattern.test(full)) return MATCH.playerB.short;
  return (full || '').split(',')[0].trim() || '?';
}

export function buildMatch(tour, pgnMap, liveStates = {}, now = Date.now()) {
  const rounds = (tour && tour.rounds) || [];
  const games = rounds.map((round, i) => {
    const text = pgnMap && pgnMap[round.id];
    const parsed = text ? parseGame(text) : null;
    const plyCount = parsed ? parsed.plies.length - 1 : 0;
    const result = parsed ? parsed.result : '*';
    let status = 'upcoming';
    if (result !== '*') status = 'finished';
    else if (round.ongoing) status = 'live';
    else if (round.finished) status = 'finished';
    else if (plyCount > 0) status = 'live';
    return {
      index: i,
      number: i + 1,
      roundId: round.id,
      name: round.name || `Game ${i + 1}`,
      url: (parsed && parsed.gameUrl) || round.url || tour.url,
      startsAt: round.startsAt,
      white: parsed ? parsed.white : '',
      black: parsed ? parsed.black : '',
      result,
      status,
      plies: parsed ? parsed.plies : [],
      baseSeconds: parsed ? parsed.baseSeconds : null,
      live: (liveStates && liveStates[round.id]) || null,
      error: parsed ? parsed.error : null,
    };
  });

  // Always show at least the scheduled number of games.
  for (let i = games.length; i < MATCH.scheduledGames; i++) {
    games.push({
      index: i, number: i + 1, roundId: null, name: `Game ${i + 1}`, url: tour && tour.url,
      startsAt: null, white: '', black: '', result: '*', status: 'upcoming', plies: [],
      baseSeconds: null, live: null, error: null,
    });
  }

  let a = 0;
  let b = 0;
  for (const g of games) {
    if (g.status !== 'finished' || g.result === '*') continue;
    const whiteIsA = MATCH.playerA.pattern.test(g.white);
    const [w, bl] = g.result === '1-0' ? [1, 0] : g.result === '0-1' ? [0, 1] : [0.5, 0.5];
    if (whiteIsA) { a += w; b += bl; } else { a += bl; b += w; }
    g.winner = w === bl ? 'draw' : (w > bl) === whiteIsA ? 'A' : 'B';
  }

  return { games, score: { a, b }, currentIndex: currentGameIndex(games, now) };
}

// Live game first; otherwise the latest game that has moves; otherwise Game 1.
export function currentGameIndex(games) {
  const live = games.find((g) => g.status === 'live');
  if (live) return live.index;
  for (let i = games.length - 1; i >= 0; i--) {
    if (games[i].status === 'finished' || games[i].plies.length > 1) return i;
  }
  return 0;
}

export function formatPoints(x) {
  const whole = Math.floor(x);
  const half = x - whole >= 0.5;
  if (!half) return String(whole);
  return whole === 0 ? '½' : `${whole}½`;
}

// Fixed facts about the match and the two data sources.
// Verified on 24 Nov 2026 against the live endpoints (see README.md).

export const MATCH = {
  title: 'World Championship 2026',
  scheduledGames: 14,
  // Matched case-insensitively against PGN player names
  // ("Gukesh D", "Sindarov, Javokhir").
  playerA: { short: 'Gukesh', pattern: /gukesh/i },
  playerB: { short: 'Sindarov', pattern: /sindarov/i },
};

export const LICHESS = {
  base: 'https://lichess.org',
  // "FIDE World Chess Championship 2026" broadcast tournament.
  tourId: 'qfkdt8mn',
  // Game 1 round. Used to rediscover the tournament if the ID above ever stops working.
  knownRoundId: 'xLgOJ6cb',
  searchQuery: 'FIDE World Chess Championship 2026',
  tourNamePattern: /world chess championship 2026/i,
  tourNameExclude: /junior|cadet|youth|women|girls|senior|amateur|university|team|rapid|blitz|freestyle|960/i,
  broadcastUrl: 'https://lichess.org/broadcast/fide-world-chess-championship-2026/qfkdt8mn',
};

export const SESSE = {
  base: 'https://analysis.sesse.net',
  liveUrl: '/analysis.pl',
  site: 'https://analysis.sesse.net/',
};

export const TIMING = {
  livePgnMs: 8000,          // round PGN poll while a game is live
  idleTourMs: 60000,        // tournament refresh while nothing is live
  liveTourMs: 120000,       // full tournament refresh while a game is live
  rateLimitBackoffMs: 61000, // Lichess asks clients to wait a minute after HTTP 429
  sesseMinGapMs: 2000,      // never ask Sesse more often than this
  sesseLongPollTimeoutMs: 60000,
  sesseRetryMs: 10000,
  fetchTimeoutMs: 15000,
};

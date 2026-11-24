// Offline tests against data captured from the live endpoints on 24 Nov 2026.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { parseGame, splitPgn, positionKey, legalPv, numberedLine, clocksAtPly, baseSeconds, parseClk } from '../src/pgn.js';
import { buildMatch, pgnByRound, formatPoints, shortName } from '../src/match.js';
import { applyDelta, describeScore, historyUrl, evalForPly, sharesHistory } from '../src/sesse.js';

const F = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('ok -', name); };

const round1 = F('round1.pgn');
const tour = JSON.parse(F('tour.json'));
const tourPgn = F('tour.pgn');

t('Game 1 PGN replays to the FEN Lichess reports for the live board', () => {
  const g = parseGame(round1);
  assert.equal(g.error, null);
  assert.equal(g.plies.length - 1, 40);
  // From GET /api/broadcast/-/-/xLgOJ6cb at the same moment (games[0].fen, lastMove h8g8).
  assert.equal(g.plies[40].fen, 'r3k1r1/1pp2pp1/4b1np/2p1P2N/pbP5/1P2BN1P/P3RPP1/3R2K1 w - - 2 21');
  assert.equal(g.plies[40].from + g.plies[40].to, 'h8g8');
  assert.equal(g.white, 'Sindarov, Javokhir');
  assert.equal(g.black, 'Gukesh D');
  assert.equal(g.roundId, 'xLgOJ6cb');
});

t('Board FEN at ply 38 equals Sesse live position at the same ply', () => {
  const g = parseGame(round1);
  // From analysis.sesse.net/analysis.pl, position.fen when position.history had 38 moves.
  assert.equal(g.plies[38].fen, 'r3k2r/1pp2pp1/4b1np/2p1P3/pbP5/1P2BNNP/P3RPP1/3R2K1 w - - 0 20');
});

t('Sesse history file names match the ones Sesse served (HTTP 200)', () => {
  const g = parseGame(round1);
  assert.equal(
    historyUrl(37, g.plies[37].sesseFen),
    'https://analysis.sesse.net/history/move37-r3k2r-1pp2pp1-2p1b1np-4P3-pbP5-1P2BNNP-P3RPP1-3R2K1_b_-_-_1_19.json',
  );
  assert.equal(
    historyUrl(1, g.plies[1].sesseFen),
    'https://analysis.sesse.net/history/move1-rnbqkbnr-pppppppp-8-8-4P3-8-PPPP1PPP-RNBQKBNR_b_KQkq_e3_0_1.json',
  );
  assert.equal(g.plies[9].sesseFen, 'r1bqkb1r/pppp1ppp/2n5/1B2p3/3Pn3/5N2/PPP2PPP/RNBQ1RK1 b kq d3 0 5');
});

t('Tournament PGN maps 14 games to 14 rounds', () => {
  const map = pgnByRound(tourPgn, tour.rounds);
  assert.equal(Object.keys(map).length, 14);
  assert.equal(splitPgn(tourPgn).length, 14);
  const m = buildMatch(tour, map);
  assert.equal(m.games.length, 14);
  assert.equal(m.games[0].status, 'live');
  assert.equal(m.games[1].status, 'upcoming');
  assert.equal(m.games[1].white, 'Gukesh D');
  assert.equal(m.currentIndex, 0);
  assert.deepEqual(m.score, { a: 0, b: 0 });
});

t('Match score and winners from finished games', () => {
  const map = pgnByRound(tourPgn, tour.rounds);
  const done = { ...map };
  done[tour.rounds[0].id] = map[tour.rounds[0].id].replace('[Result "*"]', '[Result "1/2-1/2"]').replace(/\*\s*$/, '1/2-1/2');
  done[tour.rounds[1].id] = map[tour.rounds[1].id].replace('[Result "*"]', '[Result "1-0"]').replace(/\*\s*$/, '1-0'); // Gukesh white wins
  done[tour.rounds[2].id] = map[tour.rounds[2].id].replace('[Result "*"]', '[Result "1-0"]').replace(/\*\s*$/, '1-0'); // Sindarov white wins
  const t2 = { ...tour, rounds: tour.rounds.map((r, i) => ({ ...r, ongoing: false, finished: i < 3 })) };
  const m = buildMatch(t2, done);
  assert.deepEqual(m.games.slice(0, 4).map((g) => g.status), ['finished', 'finished', 'finished', 'upcoming']);
  assert.deepEqual(m.games.slice(0, 3).map((g) => g.winner), ['draw', 'A', 'B']);
  assert.deepEqual(m.score, { a: 1.5, b: 1.5 });
  assert.equal(formatPoints(1.5), '1½');
  assert.equal(formatPoints(0.5), '½');
  assert.equal(m.currentIndex, 2);
});

t('Short names', () => {
  assert.equal(shortName('Gukesh D'), 'Gukesh');
  assert.equal(shortName('Sindarov, Javokhir'), 'Sindarov');
});

t('Score descriptions use White\'s point of view and never invent', () => {
  assert.equal(describeScore(['cp', 8]).text, '+0.08');
  assert.equal(describeScore(['cp', 8]).label, 'Equal');
  assert.equal(describeScore(['cp', -135]).text, '−1.35');
  assert.equal(describeScore(['cp', -135]).label, 'Black better');
  assert.equal(describeScore(['cp', 0]).text, '0.00');
  assert.equal(describeScore(['M', 3]).label, 'White mates in 3');
  assert.equal(describeScore(['m', 2]).share, 0);
  assert.equal(describeScore(['d', 0]).label, 'Draw (tablebase)');
  assert.ok(describeScore(['cp', 100]).share > 0.5);
  assert.equal(describeScore('Score: +0.16'), null); // old-format history files
  assert.equal(describeScore(null), null);
  assert.equal(describeScore(['cp', 'x']), null);
});

t('JSON-delta patches like the one Sesse sent', () => {
  const base = { depth: '42', nodes: '1', pv: ['a', 'b', 'c'], position: { fen: 'x' }, refutation_lines: { Bc1: {} }, keep: 1 };
  const delta = [[['depth'], '43'], [['nodes'], '541560810'], [['pv', 1], 'Rf1'], [['pv', 3], 'Rxc7'], [['refutation_lines'], { Bd2: { score: ['cp', -40] } }], [['keep']]];
  const out = applyDelta(JSON.parse(JSON.stringify(base)), delta);
  assert.equal(out.depth, '43');
  assert.deepEqual(out.pv, ['a', 'Rf1', 'c', 'Rxc7']);
  assert.deepEqual(Object.keys(out.refutation_lines), ['Bd2']);
  assert.equal('keep' in out, false);
  assert.throws(() => applyDelta({}, [[['a', 'b'], 1]]));
});

const g1 = parseGame(round1);
const sesseLive = {
  position: { fen: 'r3k1r1/1pp2pp1/4b1np/2p1P2N/pbP5/1P2BN1P/P3RPP1/3R2K1 w - - 2 21', history: g1.plies.slice(1).map((p) => p.san) },
  score: ['cp', 0], depth: '43', pv: ['Rf1', 'b6'],
  score_history: Object.fromEntries(g1.plies.map((_, i) => [String(i), ['cp', i]])),
};

t('Live Sesse eval is used only when its FEN matches the shown position', () => {
  const ev = evalForPly(sesseLive, g1.plies, 40, null);
  assert.equal(ev.source, 'live');
  assert.deepEqual(ev.score, ['cp', 0]);
  // Broadcast one move ahead of Sesse: no live eval for the new position.
  const behind = { ...sesseLive, position: { ...sesseLive.position, fen: g1.plies[39].fen, history: sesseLive.position.history.slice(0, 39) } };
  assert.equal(evalForPly(behind, g1.plies, 40, null), null);
});

t('Earlier plies use Sesse score_history only for the same game', () => {
  const ev = evalForPly(sesseLive, g1.plies, 12, null);
  assert.equal(ev.source, 'score_history');
  assert.deepEqual(ev.score, ['cp', 12]);
  assert.ok(sharesHistory(sesseLive, g1.plies));
  const other = { ...sesseLive, position: { ...sesseLive.position, history: ['d4', ...sesseLive.position.history.slice(1)] } };
  assert.equal(evalForPly(other, g1.plies, 12, null), null);
});

t('History file wins over score_history and must match the position', () => {
  const hist = { position: { fen: g1.plies[12].fen }, score: ['cp', 30], pv: ['Ne4'], depth: '60' };
  assert.equal(evalForPly(sesseLive, g1.plies, 12, hist).source, 'history');
  const wrong = { position: { fen: g1.plies[13].fen }, score: ['cp', 30] };
  assert.equal(evalForPly(sesseLive, g1.plies, 12, wrong).source, 'score_history');
  assert.equal(evalForPly(null, g1.plies, 12, wrong), null);
});

t('PV is checked for legality and numbered from the right move', () => {
  const pv = legalPv(sesseLive.position.fen, ['Rf1', 'b6', 'Qz9', 'Kh1']);
  assert.deepEqual(pv, ['Rf1', 'b6']);
  assert.equal(numberedLine(sesseLive.position.fen, pv), '21. Rf1 b6');
  assert.equal(numberedLine(g1.plies[39].fen, ['Rg8', 'Nf6']), '20… Rg8 21. Nf6');
  assert.deepEqual(legalPv(sesseLive.position.fen, ['e2e4']), []);
});

t('Odd PGN input does not crash', () => {
  const g = parseGame('[White "A"]\n[Black "B"]\n\n1. e4 {comment} (1. d4 d5) e5 2. Nf3!? Nc6 $1 3. Bxx9 *');
  assert.equal(g.plies.length - 1, 4);
  assert.ok(g.error.includes('Bxx9'));
  assert.equal(positionKey('a b c d e f'), 'a b c');
});

t('Clock readings from a live broadcast PGN', () => {
  // Format exactly as served by /api/broadcast/round/xLgOJ6cb.pgn?clocks=true on 24 Nov 2026.
  const pgn = '[White "Sindarov, Javokhir"]\n[Black "Gukesh D"]\n[TimeControl "120\'/40m + 30\'/end, 30/move from move 41"]\n\n' +
    '1. e4 { [%clk 1:59:50] } 1... e5 { [%clk 1:59:52] } 2. Nf3 { [%clk 1:59:37] } 2... Nc6 { [%clk 1:59:45] } 3. Bb5 *';
  const g = parseGame(pgn);
  assert.equal(g.error, null);
  assert.equal(g.plies.length - 1, 5);
  assert.equal(g.baseSeconds, 7200);
  assert.deepEqual(g.plies.slice(1).map((p) => p.clk), [7190, 7192, 7177, 7185, null]);
  assert.deepEqual(clocksAtPly(g.plies, 0, g.baseSeconds), [7200, 7200]);
  assert.deepEqual(clocksAtPly(g.plies, 1, g.baseSeconds), [7190, 7200]);
  assert.deepEqual(clocksAtPly(g.plies, 4, g.baseSeconds), [7177, 7185]);
  assert.deepEqual(clocksAtPly(g.plies, 5, g.baseSeconds), [7177, 7185]); // no reading on the last move yet
  assert.equal(parseClk('[%clk 0:05:42]'), 342);
  assert.equal(baseSeconds('5400+30'), 5400);
  assert.equal(baseSeconds(''), null);
});

console.log(`\n${passed} tests passed`);

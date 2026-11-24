// PGN parsing and FEN handling. All chess rules come from chess.js.
import { Chess, DEFAULT_POSITION } from '../lib/chess.js';

// Split a multi-game PGN export into one string per game.
// Games are separated by a blank line followed by a tag line ("[").
export function splitPgn(text) {
  if (!text) return [];
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n(?=\[)/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('['));
}

export function parseHeaders(text) {
  const headers = {};
  const re = /^\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/gm;
  let m;
  while ((m = re.exec(text))) headers[m[1]] = m[2].replace(/\\(.)/g, '$1');
  return headers;
}

// Insert the en-passant square whenever the last move was a double pawn push.
// chess.js 1.x only writes it when a capture is legal; Sesse's history files are
// keyed by the older convention, which always writes it.
export function fenWithEp(fen, move) {
  if (!move || !move.flags || !move.flags.includes('b')) return fen;
  const parts = fen.split(' ');
  if (parts[3] !== '-') return fen;
  const file = move.to[0];
  const rank = move.color === 'w' ? '3' : '6';
  parts[3] = file + rank;
  return parts.join(' ');
}

// Key used to decide whether two FENs describe the same position for evaluation
// purposes: placement, side to move and castling rights.
export function positionKey(fen) {
  return (fen || '').trim().split(/\s+/).slice(0, 3).join(' ');
}

export function stripSanDecorations(san) {
  return (san || '').replace(/[+#!?]+$/g, '');
}

// "[%clk 1:59:50]" -> 7190 seconds.
export function parseClk(comment) {
  const m = /\[%clk\s+(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\]/.exec(comment || '');
  return m ? +m[1] * 3600 + +m[2] * 60 + Math.floor(+m[3]) : null;
}

// Starting time from tags like TimeControl "120'/40m + 30'/end, 30/move from move 41" or "7200+30".
export function baseSeconds(tc) {
  if (!tc) return null;
  let m = /^(\d+)'/.exec(tc);
  if (m) return +m[1] * 60;
  m = /^(?:\d+\/)?(\d+)(?:\+\d+)?(?::|$)/.exec(tc);
  return m ? +m[1] : null;
}

// Move tokens and the comment that follows each, variations removed.
function moveTokens(text) {
  let body = text.replace(/^\[.*\]\s*$/gm, '').replace(/;[^\n]*/g, ' ');
  let prev;
  do {
    prev = body;
    body = body.replace(/\([^()]*\)/g, ' ');
  } while (body !== prev);
  const out = [];
  for (const tok of body.match(/\{[^}]*\}|[^\s{}]+/g) || []) {
    if (tok[0] === '{') {
      if (out.length) out[out.length - 1].comment += tok;
      continue;
    }
    if (/^\$\d+$/.test(tok)) continue;
    const san = tok.replace(/^\d+\.(\.\.)?/, '').replace(/^\d+…/, '').replace(/[!?]+$/, '');
    if (!san || /^(1-0|0-1|1\/2-1\/2|\*|\.+)$/.test(san)) continue;
    out.push({ san, comment: '' });
  }
  return out;
}

// Parse one game. Returns positions (and clock readings) for every ply so the board can step through them.
export function parseGame(text) {
  const headers = parseHeaders(text);
  const startFen = headers.FEN || DEFAULT_POSITION;
  const chess = new Chess(startFen);
  const plies = [{ fen: startFen, sesseFen: startFen, san: null, from: null, to: null, clk: null }];
  let error = null;
  for (const { san: token, comment } of moveTokens(text)) {
    let move;
    try {
      move = chess.move(token, { strict: false });
    } catch (e) {
      error = `Illegal or unreadable move "${token}" after ply ${plies.length - 1}`;
      break;
    }
    const fen = chess.fen();
    plies.push({ fen, sesseFen: fenWithEp(fen, move), san: move.san, from: move.from, to: move.to, clk: parseClk(comment) });
  }
  const url = headers.GameURL || headers.Site || '';
  const broadcastUrl = headers.BroadcastURL || '';
  return {
    headers,
    white: headers.White || '',
    black: headers.Black || '',
    result: normaliseResult(headers.Result),
    roundId: extractRoundId(broadcastUrl) || extractRoundId(url),
    gameUrl: url.startsWith('http') ? url : '',
    baseSeconds: baseSeconds(headers.TimeControl),
    plies,
    error,
  };
}

// Each side's clock after the given ply, from the [%clk] readings: [white, black] in seconds.
export function clocksAtPly(plies, ply, base = null) {
  const out = [base, base];
  for (let i = 1; i <= ply && i < plies.length; i++) {
    const mover = plies[i - 1].fen.split(' ')[1] === 'b' ? 1 : 0;
    if (plies[i].clk !== null && plies[i].clk !== undefined) out[mover] = plies[i].clk;
  }
  return out;
}

export function normaliseResult(r) {
  if (r === '1-0' || r === '0-1' || r === '1/2-1/2') return r;
  if (r === '½-½') return '1/2-1/2';
  return '*';
}

// BroadcastURL: .../broadcast/<tour-slug>/<round-slug>/<roundId>
// GameURL:      .../broadcast/<tour-slug>/<round-slug>/<roundId>/<gameId>
function extractRoundId(url) {
  const m = (url || '').match(/\/broadcast\/[^/]+\/[^/]+\/([A-Za-z0-9]{8})(?:[/?#]|$)/);
  return m ? m[1] : null;
}

// SAN list with move numbers, starting from a FEN.
export function numberedLine(fen, sans, limit = 12) {
  const parts = (fen || '').split(' ');
  let white = parts[1] !== 'b';
  let num = parseInt(parts[5], 10) || 1;
  const out = [];
  sans.slice(0, limit).forEach((san, i) => {
    if (white) out.push(`${num}. ${san}`);
    else out.push(i === 0 ? `${num}… ${san}` : san);
    if (!white) num++;
    white = !white;
  });
  if (sans.length > limit) out.push('…');
  return out.join(' ');
}

// Convert a PV given in SAN (Sesse's format) or UCI into SAN, checking legality.
export function legalPv(fen, pv) {
  if (!Array.isArray(pv) || !pv.length) return [];
  let chess;
  try {
    chess = new Chess(fen);
  } catch (e) {
    return [];
  }
  const out = [];
  for (const m of pv) {
    let move = null;
    try {
      move = chess.move(m, { strict: false });
    } catch (e) {
      const uci = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(m);
      if (uci) {
        try {
          move = chess.move({ from: uci[1], to: uci[2], promotion: uci[3] });
        } catch (e2) {
          move = null;
        }
      }
    }
    if (!move) break;
    out.push(move.san);
  }
  return out;
}

export function boardFromFen(fen) {
  const placement = (fen || DEFAULT_POSITION).split(' ')[0];
  const rows = placement.split('/');
  const board = [];
  for (let r = 0; r < 8; r++) {
    const row = [];
    for (const ch of rows[r] || '8') {
      if (/\d/.test(ch)) for (let i = 0; i < +ch; i++) row.push(null);
      else row.push(ch);
    }
    while (row.length < 8) row.push(null);
    board.push(row.slice(0, 8));
  }
  return board; // board[0] is rank 8, board[0][0] is a8
}

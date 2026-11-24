// Static 2D board. White at the bottom, no animation. Squares are built once and
// only their classes change, so redrawing on every move is cheap.
import { boardFromFen } from './pgn.js';

const FILES = 'abcdefgh';

export class Board {
  constructor(el) {
    this.el = el;
    this.squares = {};
    el.textContent = '';
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const name = FILES[f] + (8 - r);
        const sq = document.createElement('div');
        sq.className = `sq ${(r + f) % 2 ? 'dark' : 'light'}`;
        sq.dataset.square = name;
        if (f === 0) sq.appendChild(coord('rank', String(8 - r)));
        if (r === 7) sq.appendChild(coord('file', FILES[f]));
        el.appendChild(sq);
        this.squares[name] = sq;
      }
    }
  }

  render(fen, lastMove) {
    const board = boardFromFen(fen);
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const name = FILES[f] + (8 - r);
        const sq = this.squares[name];
        const p = board[r][f];
        const piece = p ? (p === p.toUpperCase() ? 'w' : 'b') + p.toUpperCase() : '';
        if (sq.dataset.piece !== piece) {
          sq.dataset.piece = piece;
          sq.style.backgroundImage = piece ? `url("pieces/${piece}.svg")` : '';
        }
        const hl = !!lastMove && (lastMove.from === name || lastMove.to === name);
        sq.classList.toggle('last', hl);
      }
    }
  }
}

function coord(kind, text) {
  const s = document.createElement('span');
  s.className = `coord ${kind}`;
  s.textContent = text;
  return s;
}

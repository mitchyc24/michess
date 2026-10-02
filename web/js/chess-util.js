// Small helpers over chessops.
import { Chess, fen as F, san as S, compat, parseUci, makeUci, makeSquare, parseSquare } from "./lib.js";

export const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const VALUES = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9 };

export function startPos(initialFen) {
  if (!initialFen) return Chess.default();
  return Chess.fromSetup(F.parseFen(initialFen).unwrap()).unwrap();
}
export const fenOf = (pos) => F.makeFen(pos.toSetup());
// Opening-book key: placement, turn, castling (no en passant, see scripts/build_openings.py).
export const bookKey = (pos) => fenOf(pos).split(" ").slice(0, 3).join(" ");
export const posFromFen = (fen) => Chess.fromSetup(F.parseFen(fen).unwrap()).unwrap();

export function material(pos, color) {
  let total = 0;
  for (const [role, v] of Object.entries(VALUES)) total += pos.board.pieces(color, role).size() * v;
  return total;
}

export function parseSanMove(pos, sanText) {
  const move = S.parseSan(pos, sanText);
  if (!move) throw new Error(`Illegal move ${sanText}`);
  return move;
}
export const makeSan = (pos, move) => S.makeSan(pos, move);
export const makeSanVariation = (pos, moves) => S.makeSanVariation(pos, moves);

// UCI from Stockfish (UCI_Chess960 mode: castling as king-takes-rook) or from the board (e1g1).
export function uciToMove(pos, uci) {
  let move = parseUci(uci);
  if (!move) return undefined;
  const piece = pos.board.get(move.from);
  if (piece?.role === "king" && !move.promotion && Math.abs((move.from % 8) - (move.to % 8)) === 2) {
    // Standard-notation castling (e1g1) -> chessops' king-onto-rook form (e1h1).
    const rook = pos.castles.rook[pos.turn][move.to > move.from ? "h" : "a"];
    if (rook !== undefined) move = { from: move.from, to: rook };
  }
  if (!pos.isLegal(move) && piece?.role === "pawn" && !move.promotion && [0, 7].includes(Math.floor(move.to / 8))) {
    move = { ...move, promotion: "queen" };
  }
  return pos.isLegal(move) ? move : undefined;
}
export const moveToUci = (move) => makeUci(move);
export const dests = (pos, chess960) => compat.chessgroundDests(pos, { chess960 });
export const sq = makeSquare;
export const squareOf = parseSquare;
// [from, to] for chessground highlighting/arrows.
export const cgMove = (move) => compat.chessgroundMove(move);

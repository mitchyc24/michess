// Cover page: an animated board replaying famous games (and, for returning players, one of their own).
import { Chessground } from "./lib.js";
import { startPos, fenOf, parseSanMove, cgMove } from "./chess-util.js";

const FAMOUS = [
  { title: "The Immortal Game", sub: "Anderssen vs Kieseritzky, London 1851", orientation: "white",
    moves: "e4 e5 f4 exf4 Bc4 Qh4+ Kf1 b5 Bxb5 Nf6 Nf3 Qh6 d3 Nh5 Nh4 Qg5 Nf5 c6 g4 Nf6 Rg1 cxb5 h4 Qg6 h5 Qg5 Qf3 Ng8 Bxf4 Qf6 Nc3 Bc5 Nd5 Qxb2 Bd6 Bxg1 e5 Qxa1+ Ke2 Na6 Nxg7+ Kd8 Qf6+ Nxf6 Be7#" },
  { title: "The Opera Game", sub: "Morphy vs Duke Karl & Count Isouard, Paris 1858", orientation: "white",
    moves: "e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#" },
  { title: "The Evergreen Game", sub: "Anderssen vs Dufresne, Berlin 1852", orientation: "white",
    moves: "e4 e5 Nf3 Nc6 Bc4 Bc5 b4 Bxb4 c3 Ba5 d4 exd4 O-O d3 Qb3 Qf6 e5 Qg6 Re1 Nge7 Ba3 b5 Qxb5 Rb8 Qa4 Bb6 Nbd2 Bb7 Ne4 Qf5 Bxd3 Qh5 Nf6+ gxf6 exf6 Rg8 Rad1 Qxf3 Rxe7+ Nxe7 Qxd7+ Kxd7 Bf5+ Ke8 Bd7+ Kf8 Bxe7#" },
];

const STEP_MS = 850;
const PAUSE_MS = 3500;

let board = null;
let playlist = FAMOUS;
let gameIdx = 0, ply = 0, frames = [], timer = null, running = false;
const $ = (sel) => document.querySelector(sel);

function prepare(game) {
  // Precompute every position of the game.
  const pos = startPos(game.initialFen);
  const out = [{ fen: fenOf(pos), last: undefined, label: "" }];
  game.moves.split(" ").forEach((san, i) => {
    const move = parseSanMove(pos, san);
    const num = Math.floor(i / 2) + 1;
    const label = i % 2 === 0 ? `${num}. ${san}` : `${num}… ${san}`;
    const last = cgMove(move);
    pos.play(move);
    out.push({ fen: fenOf(pos), last, label, check: pos.isCheck() ? pos.turn : false });
  });
  return out;
}

function loadGame(i) {
  const game = playlist[i % playlist.length];
  frames = prepare(game);
  ply = 0;
  board.set({ orientation: game.orientation, fen: frames[0].fen, lastMove: undefined, check: false });
  $("#hero-caption").textContent = game.title;
  $("#hero-sub").textContent = game.sub;
  $("#hero-move").textContent = "";
}

function tick() {
  if (!running) return;
  if (ply >= frames.length - 1) {
    timer = setTimeout(() => { gameIdx++; loadGame(gameIdx); timer = setTimeout(tick, STEP_MS); }, PAUSE_MS);
    return;
  }
  ply++;
  const f = frames[ply];
  board.set({ fen: f.fen, lastMove: f.last, check: f.check });
  $("#hero-move").textContent = f.label;
  timer = setTimeout(tick, ply === frames.length - 1 ? PAUSE_MS / 2 : STEP_MS);
}

export function init() {
  board = Chessground($("#hero-board"), {
    viewOnly: true, coordinates: false, animation: { enabled: true, duration: 350 },
    highlight: { lastMove: true, check: true }, drawable: { enabled: false },
  });
  loadGame(0);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : visible && start()));
}

let visible = false;
function start() {
  if (running) return;
  running = true;
  board.redrawAll();
  timer = setTimeout(tick, 600);
}
function stop() {
  running = false;
  clearTimeout(timer);
}
export function show() { visible = true; start(); }
export function hide() { visible = false; stop(); }

// Put one of the player's own highlight games first in the rotation.
export function setPlayerGame(game) {
  const next = game ? [game, ...FAMOUS] : FAMOUS;
  if (next[0] === playlist[0]) return;
  playlist = next;
  gameIdx = 0;
  if (board) { stop(); loadGame(0); if (visible) start(); }
}

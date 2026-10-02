// Stockfish 19 (lite, single-threaded WASM) in Web Workers. Batch analysis runs one engine per worker
// in parallel, so no SharedArrayBuffer / cross-origin isolation is needed (works on GitHub Pages).
import { startPos, fenOf, parseSanMove, moveToUci, uciToMove, makeSanVariation, INITIAL_FEN } from "./chess-util.js";

const ENGINE_URL = new URL("../engine/stockfish-19-lite-single.js", import.meta.url).href;
const MATE_CP = 10000;

class Engine {
  constructor() {
    this.worker = new Worker(ENGINE_URL);
    this.listeners = new Set();
    this.worker.onmessage = (e) => { for (const fn of [...this.listeners]) fn(String(e.data)); };
  }
  send(cmd) { this.worker.postMessage(cmd); }
  waitFor(prefix, onLine) {
    return new Promise((resolve) => {
      const fn = (line) => {
        onLine?.(line);
        if (line.startsWith(prefix)) { this.listeners.delete(fn); resolve(line); }
      };
      this.listeners.add(fn);
    });
  }
  async init(options = {}) {
    this.send("uci");
    await this.waitFor("uciok");
    // Chess960 mode makes castling unambiguous (king takes rook) for every game, standard included.
    this.send("setoption name UCI_Chess960 value true");
    for (const [k, v] of Object.entries({ Hash: 16, ...options })) this.send(`setoption name ${k} value ${v}`);
    this.send("isready");
    await this.waitFor("readyok");
    return this;
  }
  terminate() { this.worker.terminate(); }
}

function parseInfo(line) {
  if (!line.startsWith("info") || !line.includes(" score ")) return null;
  const t = line.split(" ");
  const info = { multipv: 1 };
  for (let i = 1; i < t.length; i++) {
    if (t[i] === "depth") info.depth = +t[++i];
    else if (t[i] === "multipv") info.multipv = +t[++i];
    else if (t[i] === "score") {
      const kind = t[++i], val = +t[++i];
      if (kind === "cp") info.cp = val; else info.mate = val;
      if (t[i + 1] === "lowerbound" || t[i + 1] === "upperbound") info.bound = true;
    } else if (t[i] === "pv") { info.pv = t.slice(i + 1); break; }
  }
  return info;
}

// Score from side-to-move POV -> White POV.
const whitePov = (info, whiteToMove) => {
  const s = whiteToMove ? 1 : -1;
  return [info.cp != null ? info.cp * s : null, info.mate != null ? info.mate * s : null];
};

async function evaluateGame(engine, game, nodes) {
  const pos = startPos(game.initial_fen);
  const startFen = game.initial_fen || INITIAL_FEN;
  const ucis = [];
  const evals = [];
  engine.send("ucinewgame");

  const analyse = async () => {
    if (pos.isCheckmate()) { evals.push([pos.turn === "white" ? -MATE_CP : MATE_CP, null, null]); return; }
    if (pos.isStalemate() || pos.isInsufficientMaterial()) { evals.push([0, null, null]); return; }
    const whiteToMove = pos.turn === "white";
    engine.send(`position fen ${startFen}${ucis.length ? " moves " + ucis.join(" ") : ""}`);
    engine.send(`go nodes ${nodes}`);
    let last = null;
    const best = await engine.waitFor("bestmove", (line) => {
      const info = parseInfo(line);
      if (info && info.multipv === 1 && !info.bound) last = info;
    });
    const [cp, mate] = last ? whitePov(last, whiteToMove) : [0, null];
    const bm = best.split(" ")[1];
    evals.push([cp, mate, bm && bm !== "(none)" ? bm : null]);
  };

  await analyse();
  for (const s of game.moves.split(" ")) {
    const move = parseSanMove(pos, s);
    ucis.push(moveToUci(move));
    pos.play(move);
    await analyse();
  }
  return evals;
}

// Analyse `games` with a pool of engines. Calls onGame(game, evals) as each finishes.
// Returns a controller { promise, pause(), cancel() }; pause/cancel take effect after current games.
export function analyseGames(games, { nodes = 25000, workers = defaultWorkers(), onGame, onProgress } = {}) {
  const queue = [...games];
  const total = games.reduce((a, g) => a + g.plies + 1, 0);
  let donePositions = 0, stopped = false;
  const started = performance.now();
  const engines = [];

  async function run() {
    const ready = await Promise.all(Array.from({ length: Math.min(workers, queue.length) }, () => new Engine().init()));
    engines.push(...ready);
    await Promise.all(ready.map(async (engine) => {
      while (!stopped && queue.length) {
        const game = queue.shift();
        try {
          const evals = await evaluateGame(engine, game, nodes);
          await onGame?.(game, evals);
        } catch (e) {
          console.warn(`Skipped ${game.id}: ${e.message}`);
        }
        donePositions += game.plies + 1;
        const elapsed = (performance.now() - started) / 1000;
        onProgress?.({ donePositions, total, remainingGames: queue.length,
          rate: donePositions / elapsed, eta: (elapsed / donePositions) * (total - donePositions) });
      }
    }));
    engines.forEach((e) => e.terminate());
  }
  const promise = run();
  return { promise, stop() { stopped = true; } };
}

export const defaultWorkers = () => {
  const cores = navigator.hardwareConcurrency || 4;
  // Phones and tablets: fewer engines, to limit heat, battery drain and memory (each engine ~50 MB).
  const cap = matchMedia("(pointer: coarse)").matches ? 3 : 16;
  return Math.max(1, Math.min(cap, cores - 1));
};

// One engine for interactive analysis of the position on the board.
export class LiveEngine {
  constructor() { this.ready = null; this.busy = Promise.resolve(); this.token = 0; }
  async ensure() {
    this.ready ??= new Engine().init({ Hash: 64, MultiPV: 3 });
    return this.ready;
  }
  // Streams lines via onUpdate([{cp, mate, depth, san, uci[]}]) until `ms` elapse or a newer request arrives.
  analyse(fen, { ms = 2000, multipv = 3, onUpdate } = {}) {
    const my = ++this.token;
    this.busy = this.busy.then(async () => {
      if (my !== this.token) return;
      const engine = await this.ensure();
      const pos = (await import("./chess-util.js")).posFromFen(fen);
      if (pos.isEnd()) { onUpdate?.([], true); return; }
      const whiteToMove = pos.turn === "white";
      engine.send(`setoption name MultiPV value ${multipv}`);
      engine.send(`position fen ${fen}`);
      engine.send(`go movetime ${ms}`);
      const lines = [];
      let lastEmit = 0;
      const emit = () => onUpdate?.(lines.filter(Boolean).map((l) => ({ ...l })), false);
      const cancel = setInterval(() => { if (my !== this.token) engine.send("stop"); }, 50);
      await engine.waitFor("bestmove", (line) => {
        const info = parseInfo(line);
        if (!info || !info.pv || info.bound || my !== this.token) return;
        const [cp, mate] = whitePov(info, whiteToMove);
        const moves = [];
        const p = pos.clone();
        for (const u of info.pv.slice(0, 12)) {
          const m = uciToMove(p, u);
          if (!m) break;
          moves.push(m);
          p.play(m);
        }
        lines[info.multipv - 1] = { cp, mate, depth: info.depth, uci: info.pv.slice(0, moves.length),
                                    san: makeSanVariation(pos, moves) };
        if (performance.now() - lastEmit > 150) { lastEmit = performance.now(); emit(); }
      });
      clearInterval(cancel);
      if (my === this.token) emit();
    });
    return this.busy;
  }
  stop() { this.token++; }
}

export { fenOf };

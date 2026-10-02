// Raw Lichess API game -> stored record (port of analyzer/ingest.py).
import { startPos, material, parseSanMove } from "./chess-util.js";
import { computeMetrics } from "./metrics.js";

export const SUPPORTED_VARIANTS = new Set(["standard", "chess960", "fromPosition"]);

function persistentDeficit(balances, window = 3) {
  // Worst deficit lasting `window` plies, ignoring mid-exchange gaps. Returns [deficit, ply].
  if (balances.length < window) {
    let ply = 0;
    balances.forEach((b, i) => { if (b < balances[ply]) ply = i; });
    return [Math.max(0, -balances[ply]), ply];
  }
  let worst = Infinity, ply = 0;
  for (let i = 0; i + window <= balances.length; i++) {
    const best = Math.max(...balances.slice(i, i + window));
    if (best < worst) { worst = best; ply = i; }
  }
  return [Math.max(0, -worst), ply];
}

function replay(game, myColor) {
  const pos = startPos(game.initialFen);
  const opp = myColor === "white" ? "black" : "white";
  const balances = [material(pos, myColor) - material(pos, opp)];
  const sans = game.moves.split(" ");
  let matePiece = null;
  sans.forEach((s, i) => {
    const move = parseSanMove(pos, s);
    if (i === sans.length - 1) matePiece = pos.board.get(move.from)?.role ?? null;
    pos.play(move);
    balances.push(material(pos, myColor) - material(pos, opp));
  });
  return { balances, matePiece: pos.isCheckmate() ? matePiece : null, whiteFirst: startPos(game.initialFen).turn === "white" };
}

// Lichess server analysis: one entry per ply (eval after that move). Prepend the start position and
// shift `best` so evals[i][2] is the best move *from* position i, matching Stockfish output.
export function lichessEvals(raw, plies) {
  const evals = [[null, null, null]];
  for (const e of raw.slice(0, plies)) evals.push([e.eval ?? null, e.mate ?? null, e.best ?? null]);
  const bests = evals.slice(1).map((e) => e[2]).concat([null]);
  evals.forEach((e, i) => { e[2] = bests[i]; });
  return evals;
}

export function toRecord(game, user) {
  const uid = user.toLowerCase();
  const { white, black } = game.players;
  let color, me, opp;
  if (white.user?.id === uid) [color, me, opp] = ["white", white, black];
  else if (black.user?.id === uid) [color, me, opp] = ["black", black, white];
  else return null;

  const result = game.winner == null ? "draw" : game.winner === color ? "win" : "loss";
  const moves = game.moves || "";
  const plies = moves ? moves.split(" ").length : 0;
  let deficit = null, deficitPly = null, finalBalance = null, matePiece = null, whiteFirst = true, ok = false;
  if (SUPPORTED_VARIANTS.has(game.variant) && moves) {
    try {
      const r = replay({ ...game, moves }, color);
      [deficit, deficitPly] = persistentDeficit(r.balances);
      finalBalance = r.balances.at(-1);
      matePiece = r.matePiece;
      whiteFirst = r.whiteFirst;
      ok = true;
    } catch { /* unparseable game: keep the record, skip derived facts */ }
  }

  let myMinClock = null;
  if (game.clocks?.length) {
    const offset = (color === "white") === whiteFirst ? 0 : 1;
    const mine = game.clocks.filter((_, i) => i % 2 === offset);
    if (mine.length) myMinClock = Math.min(...mine);
  }

  const oppName = opp.user?.name ?? (opp.aiLevel ? `Stockfish level ${opp.aiLevel}` : "Anonymous");
  const record = {
    id: game.id,
    user: uid,
    created_at: game.createdAt,
    last_move_at: game.lastMoveAt ?? null,
    rated: game.rated ? 1 : 0,
    variant: game.variant,
    speed: game.speed,
    perf: game.perf,
    clock_initial: game.clock?.initial ?? null,
    clock_increment: game.clock?.increment ?? null,
    status: game.status,
    color,
    result,
    my_name: me.user?.name ?? user,
    my_rating: me.rating ?? null,
    my_rating_diff: me.ratingDiff ?? null,
    opp_name: oppName,
    opp_rating: opp.rating ?? null,
    opp_title: opp.user?.title ?? null,
    rating_gap: me.rating && opp.rating ? opp.rating - me.rating : null,
    eco: game.opening?.eco ?? null,
    opening: game.opening?.name ?? null,
    plies,
    initial_fen: game.initialFen ?? null,
    moves,
    clocks: game.clocks ?? null,
    tournament: game.tournament ?? game.swiss ?? null,
    lichess_my_acc: me.analysis?.accuracy ?? null,
    lichess_opp_acc: opp.analysis?.accuracy ?? null,
    my_max_material_deficit: deficit,
    my_max_deficit_ply: deficitPly,
    final_material_balance: finalBalance,
    mate_piece: matePiece,
    my_min_clock: myMinClock,
    analysable: ok,
  };

  // Reuse Lichess server analysis when present, so those games need no local engine time.
  let analysis = null, evals = null;
  if (ok && game.analysis?.length) {
    const ev = lichessEvals(game.analysis, plies);
    evals = { id: game.id, user: uid, evals: ev };
    analysis = { id: game.id, user: uid, source: "lichess", engine_limit: "lichess-server",
                 analysed_at: Date.now(), ...computeMetrics(ev, color === "white", whiteFirst) };
  }
  return { record, analysis, evals };
}

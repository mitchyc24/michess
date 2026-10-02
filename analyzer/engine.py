"""Evaluate every position of every game with Stockfish and derive per-game metrics.

Games that already carry Lichess server analysis reuse those evals instead.
Accuracy, win% and move judgements follow Lichess's published formulas
(lila: AccuracyPercent.scala, WinPercent.scala, Advice.scala).
"""

import json
import math
import os
import statistics
import time
from multiprocessing import Pool

import chess
import chess.engine

from . import ROOT
from .db import connect

STOCKFISH = os.environ.get("STOCKFISH_PATH", str(ROOT / "engine" / "stockfish-bin"))
MATE_CP = 10000
START_CP = 15  # Lichess assumes this for the initial position


# --- Lichess formulas --------------------------------------------------------

def clamp_cp(cp, mate):
    if mate is not None:
        return 1000 if mate > 0 else -1000
    return max(-1000, min(1000, cp))


def raw_cp(cp, mate):
    """Unclamped centipawns, with mate in n encoded as +/-(10000 - n) so deeper holes sort lower."""
    if mate is not None:
        return (MATE_CP - abs(mate)) * (1 if mate > 0 else -1)
    return cp if cp is not None else 0


def win_pct(cp):
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


def move_accuracy(win_before, win_after):
    if win_after >= win_before:
        return 100.0
    raw = 103.1668100711649 * math.exp(-0.04354415386753951 * (win_before - win_after)) - 3.166924740191411
    return max(0.0, min(100.0, raw + 1))


def harmonic_mean(xs):
    xs = [max(x, 0.001) for x in xs]
    return len(xs) / sum(1 / x for x in xs)


def game_accuracy(wins, white_first=True):
    """wins: win% (white POV) for positions 0..N. Returns (white_acc, black_acc)."""
    n_moves = len(wins) - 1
    if n_moves < 2:
        return None, None
    size = max(2, min(8, n_moves // 10))
    windows = [wins[:size]] * max(0, min(size, len(wins)) - 2)
    windows += [wins[i:i + size] for i in range(len(wins) - size + 1)]
    weights = [max(0.5, min(12, statistics.pstdev(w))) for w in windows]

    per_color = {True: [], False: []}
    for i in range(n_moves):
        white_moved = (i % 2 == 0) == white_first
        before, after = wins[i], wins[i + 1]
        if not white_moved:
            before, after = 100 - before, 100 - after
        per_color[white_moved].append((move_accuracy(before, after), weights[i]))

    def combine(items):
        if not items:
            return None
        weighted = sum(a * w for a, w in items) / sum(w for _, w in items)
        return (weighted + harmonic_mean([a for a, _ in items])) / 2

    return combine(per_color[True]), combine(per_color[False])


# --- Metrics -----------------------------------------------------------------

def compute_metrics(evals, my_white, white_first=True):
    """evals: list of [cp, mate, best] per position, white POV."""
    cps = [clamp_cp(cp if cp is not None else 0, mate) for cp, mate, _ in evals]
    if evals and evals[0][0] is None and evals[0][1] is None:
        cps[0] = START_CP
    wins = [win_pct(c) for c in cps]
    white_acc, black_acc = game_accuracy(wins, white_first)
    sign = 1 if my_white else -1
    mine = [sign * c for c in cps]
    mine_raw = [sign * raw_cp(cp, mate) for cp, mate, _ in evals]
    if evals and evals[0][0] is None and evals[0][1] is None:
        mine_raw[0] = sign * START_CP
    my_wins = [w if my_white else 100 - w for w in wins]

    counts = {"inaccuracy": 0, "mistake": 0, "blunder": 0}
    opp_blunders = 0
    my_losses = []
    for i in range(len(cps) - 1):
        white_moved = (i % 2 == 0) == white_first
        i_moved = white_moved == my_white
        drop = (my_wins[i] - my_wins[i + 1]) if i_moved else (my_wins[i + 1] - my_wins[i])
        if i_moved:
            my_losses.append(max(0, mine[i] - mine[i + 1]))
            if drop >= 15:
                counts["blunder"] += 1
            elif drop >= 10:
                counts["mistake"] += 1
            elif drop >= 5:
                counts["inaccuracy"] += 1
        elif drop >= 15:
            opp_blunders += 1

    lead_changes, leader = 0, 0
    for c in cps:
        side = 1 if c > 150 else -1 if c < -150 else 0
        if side and leader and side != leader:
            lead_changes += 1
        if side:
            leader = side

    min_ply = min(range(len(mine_raw)), key=mine_raw.__getitem__)
    max_ply = max(range(len(mine_raw)), key=mine_raw.__getitem__)
    return {
        "my_accuracy": white_acc if my_white else black_acc,
        "opp_accuracy": black_acc if my_white else white_acc,
        "my_acpl": sum(my_losses) / len(my_losses) if my_losses else None,
        "my_min_cp": mine_raw[min_ply],
        "my_min_cp_ply": min_ply,
        "my_max_cp": mine_raw[max_ply],
        "my_max_cp_ply": max_ply,
        "my_min_winpct": min(my_wins),
        "my_max_winpct": max(my_wins),
        "my_inaccuracies": counts["inaccuracy"],
        "my_mistakes": counts["mistake"],
        "my_blunders": counts["blunder"],
        "opp_blunders": opp_blunders,
        "my_final_cp": mine_raw[-1],
        "lead_changes": lead_changes,
    }


# --- Evaluation --------------------------------------------------------------

def board_for(initial_fen, variant):
    chess960 = variant == "chess960"
    return chess.Board(initial_fen, chess960=chess960) if initial_fen else chess.Board(chess960=chess960)


def lichess_to_evals(raw, plies):
    """Lichess analysis has one entry per ply (eval after that move); prepend the start."""
    evals = [[None, None, None]]
    for entry in raw[:plies]:
        best = entry.get("best")
        evals.append([entry.get("eval"), entry.get("mate"), best])
    # Lichess's 'best' is the move that should have been played instead of this ply;
    # shift so evals[i][2] is the best move *from* position i, matching Stockfish output.
    shifted = [e[2] for e in evals[1:]] + [None]
    for i, e in enumerate(evals):
        e[2] = shifted[i]
    return evals


_engine = None
_limit = None


def _init_worker(limit_kwargs, hash_mb):
    global _engine, _limit
    _engine = chess.engine.SimpleEngine.popen_uci(STOCKFISH)
    _engine.configure({"Threads": 1, "Hash": hash_mb})
    _limit = chess.engine.Limit(**limit_kwargs)


def evaluate_game(task):
    game_id, moves, initial_fen, variant = task
    board = board_for(initial_fen, variant)
    _engine.protocol.send_line("ucinewgame")
    evals = []

    def analyse():
        if board.is_checkmate():
            evals.append([-MATE_CP if board.turn == chess.WHITE else MATE_CP, None, None])
        elif board.is_game_over():
            evals.append([0, None, None])
        else:
            info = _engine.analyse(board, _limit)
            score = info["score"].white()
            best = info["pv"][0].uci() if info.get("pv") else None
            evals.append([score.score(), score.mate(), best])

    try:
        analyse()
        for san in moves.split():
            board.push_san(san)
            analyse()
    except (ValueError, chess.engine.EngineError) as e:
        return game_id, None, str(e)
    return game_id, evals, None


def save(conn, row, evals, source, limit_desc):
    white_first = board_for(row["initial_fen"], row["variant"]).turn == chess.WHITE
    metrics = compute_metrics(evals, row["color"] == "white", white_first)
    conn.execute(
        """INSERT OR REPLACE INTO analysis (game_id, source, engine_limit, evals, analysed_at, {cols})
           VALUES (?, ?, ?, ?, ?, {qs})""".format(cols=",".join(metrics), qs=",".join("?" * len(metrics))),
        (row["id"], source, limit_desc, json.dumps(evals), int(time.time()), *metrics.values()),
    )


def analyse_all(user, nodes=25000, depth=None, workers=None, limit=None, use_lichess=True, hash_mb=32):
    conn = connect()
    rows = conn.execute(
        """SELECT g.* FROM games g LEFT JOIN analysis a ON a.game_id = g.id
           WHERE g.user = ? AND a.game_id IS NULL AND g.plies > 0
             AND g.variant IN ('standard', 'chess960', 'fromPosition')
           ORDER BY g.created_at DESC""",
        (user.lower(),),
    ).fetchall()

    if use_lichess:
        from_lichess = [r for r in rows if r["lichess_evals"]]
        for r in from_lichess:
            save(conn, r, lichess_to_evals(json.loads(r["lichess_evals"]), r["plies"]), "lichess", "lichess-server")
        conn.commit()
        rows = [r for r in rows if not r["lichess_evals"]]
        if from_lichess:
            print(f"Used Lichess server analysis for {len(from_lichess)} games")

    if limit:
        rows = rows[:limit]
    if not rows:
        print("Nothing left to analyse.")
        return

    limit_kwargs = {"depth": depth} if depth else {"nodes": nodes}
    limit_desc = ",".join(f"{k}={v}" for k, v in limit_kwargs.items())
    workers = workers or max(1, (os.cpu_count() or 2) - 2)
    by_id = {r["id"]: r for r in rows}
    tasks = [(r["id"], r["moves"], r["initial_fen"], r["variant"]) for r in rows]
    total_plies = sum(r["plies"] for r in rows)
    print(f"Analysing {len(rows)} games ({total_plies} positions) with {workers} workers, {limit_desc}")

    start, done, done_plies = time.time(), 0, 0
    with Pool(workers, initializer=_init_worker, initargs=(limit_kwargs, hash_mb)) as pool:
        for game_id, evals, err in pool.imap_unordered(evaluate_game, tasks, chunksize=4):
            done += 1
            done_plies += by_id[game_id]["plies"]
            if err:
                print(f"  {game_id}: skipped ({err})")
                continue
            save(conn, by_id[game_id], evals, "stockfish", limit_desc)
            if done % 50 == 0:
                conn.commit()
                elapsed = time.time() - start
                eta = elapsed / done_plies * (total_plies - done_plies)
                print(f"  {done}/{len(rows)} games, {elapsed / 60:.1f} min elapsed, ~{eta / 60:.0f} min left", flush=True)
    conn.commit()
    print(f"Done in {(time.time() - start) / 60:.1f} min")


def recompute_metrics(conn=None):
    """Re-derive analysis metrics from stored evals (after changing a formula)."""
    conn = conn or connect()
    rows = conn.execute("SELECT g.color, g.initial_fen, g.variant, a.game_id, a.evals FROM analysis a "
                        "JOIN games g ON g.id = a.game_id").fetchall()
    for r in rows:
        white_first = board_for(r["initial_fen"], r["variant"]).turn == chess.WHITE
        m = compute_metrics(json.loads(r["evals"]), r["color"] == "white", white_first)
        conn.execute(f"UPDATE analysis SET {', '.join(k + ' = ?' for k in m)} WHERE game_id = ?",
                     (*m.values(), r["game_id"]))
    conn.commit()
    print(f"Recomputed metrics for {len(rows)} games")

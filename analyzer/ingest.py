"""Load raw Lichess NDJSON into SQLite, computing engine-free facts on the way."""

import json

import chess

from .db import connect
from .fetch import raw_path

PIECE_VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9}
SUPPORTED_VARIANTS = {"standard", "chess960", "fromPosition"}


def material(board, color):
    return sum(len(board.pieces(pt, color)) * v for pt, v in PIECE_VALUES.items())


def starting_board(game):
    fen = game.get("initialFen")
    chess960 = game.get("variant") == "chess960"
    return chess.Board(fen, chess960=chess960) if fen else chess.Board(chess960=chess960)


def replay(game, my_color):
    """Return (balances, mate_piece) where balances[i] is my material lead after ply i."""
    board = starting_board(game)
    balances = [material(board, my_color) - material(board, not my_color)]
    mate_piece = None
    moves = game.get("moves", "").split()
    for i, san in enumerate(moves):
        move = board.parse_san(san)
        if i == len(moves) - 1:
            mate_piece = chess.piece_name(board.piece_type_at(move.from_square))
        board.push(move)
        balances.append(material(board, my_color) - material(board, not my_color))
    if not board.is_checkmate():
        mate_piece = None
    return balances, mate_piece


def persistent_deficit(balances, window=3):
    """Worst material deficit that lasted at least `window` plies.

    Mid-exchange positions (a piece taken, recaptured next move) shouldn't count
    as being "down a piece", so take the best balance within each window first.
    Returns (deficit, ply) where ply is the start of the worst stretch.
    """
    if len(balances) < window:
        ply = min(range(len(balances)), key=balances.__getitem__)
        return max(0, -balances[ply]), ply
    best_in_window = [max(balances[i:i + window]) for i in range(len(balances) - window + 1)]
    ply = min(range(len(best_in_window)), key=best_in_window.__getitem__)
    return max(0, -best_in_window[ply]), ply


def to_row(game, user):
    uid = user.lower()
    white, black = game["players"]["white"], game["players"]["black"]
    if white.get("user", {}).get("id") == uid:
        color, me, opp = "white", white, black
    elif black.get("user", {}).get("id") == uid:
        color, me, opp = "black", black, white
    else:
        return None

    winner = game.get("winner")
    result = "draw" if winner is None else ("win" if winner == color else "loss")
    my_color = chess.WHITE if color == "white" else chess.BLACK

    balances, mate_piece, deficit, deficit_ply, final_balance = None, None, None, None, None
    if game.get("variant") in SUPPORTED_VARIANTS and game.get("moves"):
        try:
            balances, mate_piece = replay(game, my_color)
            deficit, deficit_ply = persistent_deficit(balances)
            final_balance = balances[-1]
        except ValueError:
            pass

    clocks = game.get("clocks")
    my_min_clock = None
    if clocks:
        first_mover_white = starting_board(game).turn == chess.WHITE if game.get("variant") in SUPPORTED_VARIANTS else True
        offset = 0 if (my_color == chess.WHITE) == first_mover_white else 1
        mine = clocks[offset::2]
        my_min_clock = min(mine) if mine else None

    opp_user = opp.get("user", {})
    opp_name = opp_user.get("name") or (f"Stockfish level {opp['aiLevel']}" if "aiLevel" in opp else "Anonymous")
    my_rating, opp_rating = me.get("rating"), opp.get("rating")
    clock = game.get("clock") or {}
    opening = game.get("opening") or {}
    evals = game.get("analysis")

    return {
        "id": game["id"],
        "user": uid,
        "created_at": game["createdAt"],
        "last_move_at": game.get("lastMoveAt"),
        "rated": int(bool(game.get("rated"))),
        "variant": game.get("variant"),
        "speed": game.get("speed"),
        "perf": game.get("perf"),
        "clock_initial": clock.get("initial"),
        "clock_increment": clock.get("increment"),
        "status": game.get("status"),
        "color": color,
        "result": result,
        "my_rating": my_rating,
        "my_rating_diff": me.get("ratingDiff"),
        "opp_name": opp_name,
        "opp_rating": opp_rating,
        "opp_title": opp_user.get("title"),
        "rating_gap": (opp_rating - my_rating) if (my_rating and opp_rating) else None,
        "eco": opening.get("eco"),
        "opening": opening.get("name"),
        "plies": len(game.get("moves", "").split()),
        "initial_fen": game.get("initialFen"),
        "moves": game.get("moves", ""),
        "clocks": json.dumps(clocks) if clocks else None,
        "tournament": game.get("tournament") or game.get("swiss"),
        "lichess_evals": json.dumps(evals) if evals else None,
        "lichess_my_acc": me.get("analysis", {}).get("accuracy"),
        "lichess_opp_acc": opp.get("analysis", {}).get("accuracy"),
        "my_max_material_deficit": deficit,
        "my_max_deficit_ply": deficit_ply,
        "final_material_balance": final_balance,
        "mate_piece": mate_piece,
        "my_min_clock": my_min_clock,
        "pgn": game.get("pgn"),
    }


def ingest(user):
    path = raw_path(user)
    if not path.exists():
        raise SystemExit(f"No raw data at {path}; run `fetch` first.")
    conn = connect()
    known = {r[0] for r in conn.execute("SELECT id FROM games")}
    rows, skipped = [], 0
    with path.open() as f:
        for line in f:
            if not line.strip():
                continue
            game = json.loads(line)
            if game["id"] in known:
                continue
            row = to_row(game, user)
            if row is None:
                skipped += 1
                continue
            rows.append(row)
            known.add(game["id"])
    if rows:
        cols = list(rows[0])
        conn.executemany(
            f"INSERT OR REPLACE INTO games ({','.join(cols)}) VALUES ({','.join(':' + c for c in cols)})",
            rows,
        )
        conn.commit()
    total = conn.execute("SELECT COUNT(*) FROM games WHERE user = ?", (user.lower(),)).fetchone()[0]
    print(f"Ingested {len(rows)} new games ({skipped} skipped); {total} total for {user}")
    return len(rows)

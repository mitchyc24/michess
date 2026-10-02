"""Opening tree: every move sequence you've played, with results, labelled by Lichess opening names.

Nodes are positions reached by a move sequence (a tree, so transpositions appear on
separate branches); opening names are matched by position, so a transposed line is
still labelled correctly. Names come from github.com/lichess-org/chess-openings
(resources/openings/*.tsv).
"""

import csv
import time
from functools import lru_cache

import chess

from . import ROOT

BOOK_DIR = ROOT / "resources" / "openings"


def epd(board):
    return " ".join(board.fen().split()[:4])


@lru_cache(maxsize=1)
def book():
    """{position (EPD): (eco, name)} for every named Lichess opening."""
    out = {}
    for path in sorted(BOOK_DIR.glob("*.tsv")):
        with path.open() as f:
            for row in csv.DictReader(f, delimiter="\t"):
                board = chess.Board()
                for tok in row["pgn"].split():
                    if not tok[0].isdigit():
                        board.push_san(tok)
                out[epd(board)] = (row["eco"], row["name"])
    return out


def filters_sql(q):
    """Shared WHERE clause for tree queries. Standard chess from the initial position only."""
    where = ["user = ?", "variant = 'standard'", "initial_fen IS NULL", "color = ?"]
    params = [q["user"].lower(), q.get("color", "white")]
    speeds = [s for s in (q.get("speed") or "").split(",") if s]
    if speeds:
        where.append(f"speed IN ({','.join('?' * len(speeds))})")
        params += speeds
    if q.get("rated") in ("0", "1"):
        where.append("rated = ?")
        params.append(int(q["rated"]))
    if q.get("since"):
        where.append("created_at >= ?")
        params.append(int(q["since"]))
    if q.get("until"):
        where.append("created_at < ?")
        params.append(int(q["until"]))
    return " AND ".join(where), params


def _new_node(san=None):
    return {"san": san, "n": 0, "w": 0, "d": 0, "l": 0, "opp": 0, "opp_n": 0, "children": {}}


def build_tree(conn, q, max_ply=14, min_games=3):
    started = time.time()
    where, params = filters_sql(q)
    rows = conn.execute(f"SELECT moves, result, opp_rating FROM games WHERE {where}", params).fetchall()

    root = _new_node()
    for moves, result, opp_rating in rows:
        node = root
        path = [root]
        for san in moves.split()[:max_ply]:
            node = node["children"].setdefault(san, _new_node(san))
            path.append(node)
        for n in path:
            n["n"] += 1
            n[{"win": "w", "draw": "d", "loss": "l"}[result]] += 1
            if opp_rating:
                n["opp"] += opp_rating
                n["opp_n"] += 1

    names = book()
    board = chess.Board()
    count = 0

    def finish(node, ply):
        nonlocal count
        count += 1
        named = names.get(epd(board))
        out = {
            "san": node["san"],
            "ply": ply,
            "n": node["n"], "w": node["w"], "d": node["d"], "l": node["l"],
            "opp": round(node["opp"] / node["opp_n"]) if node["opp_n"] else None,
            "fen": board.fen(),
        }
        if named:
            out["eco"], out["name"] = named
        kids = sorted((c for c in node["children"].values() if c["n"] >= min_games), key=lambda c: -c["n"])
        out["children"] = []
        for child in kids:
            move = board.push_san(child["san"])
            sub = finish(child, ply + 1)
            sub["uci"] = move.uci()
            out["children"].append(sub)
            board.pop()
        return out

    tree = finish(root, 0)
    tree["name"] = "Starting position"
    return {"tree": tree, "games": len(rows), "nodes": count, "max_ply": max_ply, "min_games": min_games,
            "color": q.get("color", "white"), "ms": round((time.time() - started) * 1000)}


def games_at(conn, q, moves, limit=50):
    """Games (newest first) whose move list starts with `moves` (space-separated SAN)."""
    where, params = filters_sql(q)
    if moves:
        where += " AND (moves = ? OR moves LIKE ?)"
        params += [moves, moves + " %"]
    sql = f"""SELECT g.id, g.created_at, g.speed, g.result, g.status, g.opp_name, g.opp_rating, g.opp_title,
                     g.my_rating, g.plies, g.opening, a.my_accuracy
              FROM games g LEFT JOIN analysis a ON a.game_id = g.id
              WHERE {where} ORDER BY g.created_at DESC LIMIT ?"""
    return [dict(r) for r in conn.execute(sql, (*params, limit)).fetchall()]

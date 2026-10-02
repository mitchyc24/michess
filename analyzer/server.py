"""Local web viewer: browse highlights and all games, replay them with eval graphs, explore with Stockfish.

Stdlib HTTP server; the board UI lives in viewer/. Run with `./chess serve`.
"""

import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import chess
import chess.engine

from . import DATA, ROOT, config
from .db import connect
from .engine import STOCKFISH, board_for
from .export import annotated_pgn
from .openings import build_tree, games_at

VIEWER = ROOT / "viewer"

_engine = None
_engine_lock = threading.Lock()


def engine():
    global _engine
    if _engine is None:
        _engine = chess.engine.SimpleEngine.popen_uci(STOCKFISH)
        _engine.configure({"Threads": 4, "Hash": 256})
    return _engine


def dests(board):
    out = {}
    for m in board.legal_moves:
        out.setdefault(chess.square_name(m.from_square), []).append(chess.square_name(m.to_square))
    return out


def position(board):
    return {
        "fen": board.fen(),
        "turn": "white" if board.turn else "black",
        "check": board.is_check(),
        "dests": dests(board),
        "game_over": board.is_game_over(),
    }


def game_detail(conn, game_id):
    row = conn.execute("SELECT * FROM games WHERE id = ?", (game_id,)).fetchone()
    if row is None:
        return None
    a = conn.execute("SELECT * FROM analysis WHERE game_id = ?", (game_id,)).fetchone()
    board = board_for(row["initial_fen"], row["variant"])
    clocks = json.loads(row["clocks"]) if row["clocks"] else []
    evals = json.loads(a["evals"]) if a else None
    def best_from(ply):
        best = evals[ply][2] if evals and ply < len(evals) else None
        if not best:
            return None, None
        try:
            return best, board.san(chess.Move.from_uci(best))
        except (ValueError, AssertionError):
            return None, None

    best, best_san = best_from(0)
    plies = [{"fen": board.fen(), "san": None, "uci": None, "clock": None, "best": best, "best_san": best_san}]
    for i, san in enumerate(row["moves"].split()):
        move = board.parse_san(san)
        board.push(move)
        best, best_san = best_from(i + 1)
        plies.append({"fen": board.fen(), "san": san, "uci": move.uci(),
                      "clock": clocks[i] if i < len(clocks) else None, "best": best, "best_san": best_san})
    detail = {k: row[k] for k in row.keys() if k not in ("pgn", "clocks", "lichess_evals", "moves")}
    detail["plies"] = plies
    detail["evals"] = [[e[0], e[1]] for e in evals] if evals else None
    if a:
        detail["analysis"] = {k: a[k] for k in a.keys() if k not in ("evals",)}
    detail["chess960"] = row["variant"] == "chess960"
    return detail


SORTS = {
    "date": "g.created_at DESC",
    "gap": "g.rating_gap DESC",
    "opp": "g.opp_rating DESC",
    "length": "g.plies DESC",
    "accuracy": "a.my_accuracy DESC",
    "comeback": "a.my_min_winpct ASC",
}


def list_games(conn, q):
    where, params = ["1 = 1"], []
    for key in ("result", "speed", "color", "status"):
        if q.get(key):
            where.append(f"g.{key} = ?")
            params.append(q[key])
    if q.get("q"):
        where.append("(g.opp_name LIKE ? OR g.opening LIKE ? OR g.eco LIKE ? OR g.id = ?)")
        like = f"%{q['q']}%"
        params += [like, like, like, q["q"]]
    if q.get("rated") in ("0", "1"):
        where.append("g.rated = ?")
        params.append(int(q["rated"]))
    order = SORTS.get(q.get("sort"), SORTS["date"])
    if q.get("sort") in ("accuracy", "comeback"):
        where.append("a.game_id IS NOT NULL")
    limit = min(int(q.get("limit", 100)), 500)
    offset = int(q.get("offset", 0))
    sql = f"""SELECT g.id, g.created_at, g.speed, g.color, g.result, g.status, g.my_rating, g.opp_name,
                     g.opp_rating, g.opp_title, g.rating_gap, g.opening, g.eco, g.plies, g.clock_initial,
                     g.clock_increment, a.my_accuracy, a.my_min_cp
              FROM games g LEFT JOIN analysis a ON a.game_id = g.id
              WHERE {' AND '.join(where)} ORDER BY {order} LIMIT ? OFFSET ?"""
    rows = conn.execute(sql, (*params, limit, offset)).fetchall()
    total = conn.execute(f"SELECT COUNT(*) FROM games g LEFT JOIN analysis a ON a.game_id = g.id "
                         f"WHERE {' AND '.join(where)}", params).fetchone()[0]
    return {"total": total, "games": [dict(r) for r in rows]}


def analyse_fen(fen, chess960, multipv, movetime):
    board = chess.Board(fen, chess960=chess960)
    if board.is_game_over():
        return {"lines": [], "game_over": True}
    with _engine_lock:
        infos = engine().analyse(board, chess.engine.Limit(time=movetime), multipv=multipv)
    lines = []
    for info in infos:
        score = info["score"].white()
        pv = info.get("pv", [])[:12]
        lines.append({"cp": score.score(), "mate": score.mate(), "depth": info.get("depth"),
                      "uci": [m.uci() for m in pv], "san": board.variation_san(pv) if pv else ""})
    return {"lines": lines}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(VIEWER), **kwargs)

    def log_message(self, fmt, *args):
        pass

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if not url.path.startswith("/api/"):
            return super().do_GET()
        try:
            conn = connect()
            if url.path == "/api/tree":
                q.setdefault("user", config.user())
                return self.send_json(build_tree(conn, q, max_ply=min(int(q.get("max_ply", 14)), 40),
                                                 min_games=max(int(q.get("min_games", 3)), 1)))
            if url.path == "/api/tree/games":
                q.setdefault("user", config.user())
                return self.send_json(games_at(conn, q, q.get("moves", ""), min(int(q.get("limit", 50)), 500)))
            if url.path == "/api/highlights":
                path = DATA / "highlights.json"
                return self.send_json(json.loads(path.read_text()) if path.exists() else {"categories": []})
            if url.path == "/api/games":
                return self.send_json(list_games(conn, q))
            if url.path.startswith("/api/game/"):
                detail = game_detail(conn, url.path.rsplit("/", 1)[1])
                return self.send_json(detail) if detail else self.send_json({"error": "not found"}, 404)
            if url.path.startswith("/api/pgn/"):
                body = annotated_pgn(url.path.rsplit("/", 1)[1], conn=conn).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/x-chess-pgn")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                return self.wfile.write(body)
            if url.path == "/api/position":
                return self.send_json(position(chess.Board(q["fen"], chess960=q.get("chess960") == "1")))
            if url.path == "/api/move":
                board = chess.Board(q["fen"], chess960=q.get("chess960") == "1")
                move = chess.Move.from_uci(q["uci"])
                if move not in board.legal_moves:
                    # Auto-queen if a promotion square was reached without a piece choice.
                    move = chess.Move.from_uci(q["uci"] + "q")
                    if move not in board.legal_moves:
                        return self.send_json({"error": "illegal"}, 400)
                san = board.san(move)
                board.push(move)
                return self.send_json({"san": san, "uci": move.uci(), **position(board)})
            if url.path == "/api/engine":
                return self.send_json(analyse_fen(q["fen"], q.get("chess960") == "1",
                                                  min(int(q.get("multipv", 3)), 5),
                                                  min(float(q.get("time", 1.0)), 10.0)))
            self.send_json({"error": "unknown endpoint"}, 404)
        except (KeyError, ValueError) as e:
            self.send_json({"error": str(e)}, 400)


def serve(port=8765):
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Viewer running at http://127.0.0.1:{port}  (Ctrl-C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if _engine:
            _engine.quit()
